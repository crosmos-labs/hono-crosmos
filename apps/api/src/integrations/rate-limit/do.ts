import { createLogger } from '@crosmos/observability';
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
  constructor(private readonly ns: DurableObjectNamespace) {}

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

    try {
      // ONE round-trip for both windows. They used to live in separate DO
      // instances and cost a fetch each; every gated request paid for both, so
      // the incident logged five `ratelimit/limit` calls per search. The
      // counters are still independent (keyed by scope inside the DO), so this
      // changes cost, not enforcement.
      const res = await this.stub(keyFor(input.orgId, input.namespace)).fetch(
        'https://ratelimit/limit',
        { method: 'POST', body: JSON.stringify({ windows }) },
      );
      const { results } = (await res.json()) as {
        success: boolean;
        results: Array<{ scope: RateLimitScope; success: boolean; count: number }>;
      };
      // Enforce rpm before day (windows[] order), matching the KV limiter.
      for (const w of windows) {
        const r = results.find((x) => x.scope === w.scope);
        if (r && !r.success) throw new RateLimitError(w.scope, w.limit, r.count);
      }
    } catch (err) {
      if (err instanceof RateLimitError) throw err;
      // Fail open — a DO blip must not 429 real traffic (matches KvRateLimiter).
      createLogger({ service: 'api' }).error('rate_limit.do_failure', {
        org_id: input.orgId,
        stage: 'rate_limit_check',
      }, err);
    }
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
