import { createLogger } from '@crosmos/observability';
import type { DeferFn } from './kv';
import {
  type RateLimitCheck,
  type RateLimiter,
  RateLimitError,
  type RateLimitScope,
} from './port';

/** Window lengths, matching the KV limiter's fixed windows. */
const RPM_WINDOW_SECONDS = 60;
const DAY_WINDOW_SECONDS = 86_400;

/**
 * How long a request will wait on the limiter before admitting anyway.
 *
 * The counters live in a DO instance keyed PER ORG, so a quiet org's instance is
 * usually evicted between requests and the next caller pays its cold start. In
 * production that shows up as a `plan_rate_limit` stage that normally costs
 * ~200ms but intermittently stalls for 5-9s, entirely ahead of the DO's own
 * execution (the inner request measures ~0ms once it lands). The single global
 * throttle DO never does this because every request keeps it warm.
 *
 * A slow limiter must not be able to add seconds to a user's search, so we stop
 * waiting after this budget and admit. The call is NOT cancelled: it is handed
 * to `defer` (waitUntil) so the increment still lands and the window stays
 * accurate. Enforcement is therefore delayed, never skipped.
 */
const CHECK_BUDGET_MS = 250;

/**
 * Durable-Object-backed per-org rate limiter — the strongly-consistent
 * replacement for {@link KvRateLimiter}. Each fixed-window counter (rpm, day)
 * lives in its own `RateLimiterDO` instance keyed by `idFromName`, so the
 * check-and-increment is atomic (no ±1–2 drift) and, crucially, costs **zero
 * KV put operations** — the counter is in-memory in the DO, not a KV write.
 * This is why it replaced the KV limiter: every authenticated request writes
 * these counters, and on the KV path that was ~2–4 puts/request against the
 * free tier's 1000/day put cap.
 *
 * Semantics match {@link KvRateLimiter} exactly:
 *   - `-1` limit → that window is skipped (uncapped).
 *   - The DO increments on EVERY call (even over-limit), so the window keeps
 *     advancing — mirrors Python's increment-before-check.
 *   - Fail **open**: a DO blip is logged and the request is allowed. A limiter
 *     hiccup must never 429 real traffic.
 *
 * Keys stay wire-compatible with the KV prefixes (`rl:rpm:*`, `rl:day:*`,
 * `rl:<ns>:rpm:*`, …) so the two implementations reason about the same buckets.
 */
export class DoRateLimiter implements RateLimiter {
  constructor(
    private readonly ns: DurableObjectNamespace,
    private readonly defer?: DeferFn,
    private readonly budgetMs: number = CHECK_BUDGET_MS,
    // Without this both log lines below default to `environment: development`,
    // which is what production emitted before this was threaded through.
    private readonly environment?: string,
  ) {}

  private get logger() {
    return createLogger({ service: 'api', environment: this.environment });
  }

  private stub(key: string): DurableObjectStub {
    const id = this.ns.idFromName(key);
    // `enam` pins the DO near the prod workers' region (aws:us-east-1) so the
    // check round-trip stays intra-region. Honored at first creation only.
    return this.ns.get(id, { locationHint: 'enam' });
  }

  async check(input: RateLimitCheck): Promise<void> {
    const windows: Array<{
      limit: number;
      scope: RateLimitScope;
      windowSeconds: number;
    }> = [];
    if (input.rpmLimit !== -1) {
      windows.push({
        limit: input.rpmLimit,
        scope: 'rpm',
        windowSeconds: RPM_WINDOW_SECONDS,
      });
    }
    if (input.dailyLimit !== -1) {
      windows.push({
        limit: input.dailyLimit,
        scope: 'day',
        windowSeconds: DAY_WINDOW_SECONDS,
      });
    }
    if (windows.length === 0) return;

    // Start the round-trip, then bound how long the user waits for it.
    const call = this.callDo(keyFor(input.orgId, input.namespace), windows);
    let outcome: LimitWindowResult[] | typeof OVER_BUDGET;
    try {
      outcome = await withBudget(call, this.budgetMs);
    } catch (err) {
      // Transport failure. Fail OPEN — a limiter blip must never 429 real
      // traffic (matches KvRateLimiter).
      this.logger.error('rate_limit.do_failure', {
        org_id: input.orgId,
        stage: 'rate_limit_check',
      }, err);
      return;
    }

    if (outcome === OVER_BUDGET) {
      // The limiter is cold or slow. Admit now rather than holding a search
      // open for seconds, but keep the in-flight call alive on `defer` so the
      // counter still increments and the fixed window stays accurate. The only
      // thing given up is enforcing THIS request against a limit it may have
      // exceeded; the always-warm global AI throttle still bounds aggregate
      // cost, which is what actually protects spend.
      call.catch(() => {}); // never surface as an unhandled rejection
      this.defer?.(call);
      this.logger.warn('rate_limit.do_over_budget', {
        org_id: input.orgId,
        stage: 'rate_limit_check',
        duration_ms: this.budgetMs,
      });
      return;
    }

    // Enforce rpm before day (windows[] order), matching the KV limiter.
    for (const w of windows) {
      const r = outcome.find((x) => x.scope === w.scope);
      if (r && !r.success) throw new RateLimitError(w.scope, w.limit, r.count);
    }
  }

  /**
   * ONE round-trip for both windows. They used to live in separate DO instances
   * and cost a fetch each; every gated request paid for both, so the incident
   * logged five `ratelimit/limit` calls per search. The counters are still
   * independent (keyed by scope inside the DO), so this changes cost, not
   * enforcement.
   */
  private async callDo(
    key: string,
    windows: Array<{ limit: number; scope: RateLimitScope; windowSeconds: number }>,
  ): Promise<LimitWindowResult[]> {
    const res = await this.stub(key).fetch('https://ratelimit/limit', {
      method: 'POST',
      body: JSON.stringify({ windows }),
    });
    const { results } = (await res.json()) as {
      success: boolean;
      results: LimitWindowResult[];
    };
    return results;
  }
}

interface LimitWindowResult {
  scope: RateLimitScope;
  success: boolean;
  count: number;
}

/** Sentinel: the limiter did not answer inside its latency budget. */
const OVER_BUDGET = Symbol('rate_limit_over_budget');

/**
 * Resolve with the call's result, or with {@link OVER_BUDGET} once `budgetMs`
 * elapses. The underlying call is deliberately NOT cancelled — the caller hands
 * it to `waitUntil` so the counter still increments.
 */
async function withBudget<T>(
  call: Promise<T>,
  budgetMs: number,
): Promise<T | typeof OVER_BUDGET> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call,
      new Promise<typeof OVER_BUDGET>((resolve) => {
        timer = setTimeout(() => resolve(OVER_BUDGET), budgetMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Durable Object instance name holding ALL of an org's windows for a namespace:
 * `rl:<org>`, or `rl:<ns>:<org>` for a namespaced limit (e.g. `'mgmt'`).
 *
 * This no longer includes the window in the name — one instance now holds both
 * the `rpm` and `day` counters, which is what collapses the two round-trips into
 * one. It therefore diverges from `KvRateLimiter`'s per-window key layout; the
 * KV limiter is an inactive fallback (RATE_LIMITER is bound in every env) and
 * keeps its own keys, so the two never share a bucket in practice.
 *
 * Deploying this moves counters to new instances, so windows reset once. That is
 * already the documented behavior of this class on DO eviction, and resetting a
 * fixed window early only ever grants allowance — it cannot 429 anyone.
 */
function keyFor(orgId: number, namespace?: string): string {
  return namespace ? `rl:${namespace}:${orgId}` : `rl:${orgId}`;
}
