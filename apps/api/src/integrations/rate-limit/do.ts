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
      key: string;
      limit: number;
      scope: RateLimitScope;
      windowSeconds: number;
    }> = [];
    if (input.rpmLimit !== -1) {
      windows.push({
        key: keyFor('rpm', input.orgId, input.namespace),
        limit: input.rpmLimit,
        scope: 'rpm',
        windowSeconds: RPM_WINDOW_SECONDS,
      });
    }
    if (input.dailyLimit !== -1) {
      windows.push({
        key: keyFor('day', input.orgId, input.namespace),
        limit: input.dailyLimit,
        scope: 'day',
        windowSeconds: DAY_WINDOW_SECONDS,
      });
    }
    if (windows.length === 0) return;

    try {
      // Both windows are independent DO instances, so fire them in parallel.
      // Each increments and reports its own count.
      const results = await Promise.all(
        windows.map(async (w) => {
          const res = await this.stub(w.key).fetch('https://ratelimit/limit', {
            method: 'POST',
            body: JSON.stringify({ limit: w.limit, windowSeconds: w.windowSeconds }),
          });
          const { success, count } = (await res.json()) as {
            success: boolean;
            count: number;
          };
          return { w, success, count };
        }),
      );
      // Enforce rpm before day (windows[] order), matching the KV limiter.
      for (const { w, success, count } of results) {
        if (!success) throw new RateLimitError(w.scope, w.limit, count);
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
 * Counter key for a window. Wire-compatible with `KvRateLimiter`'s prefixes so
 * both implementations name the same buckets: `rl:rpm:<org>` / `rl:day:<org>`,
 * or namespaced `rl:<ns>:rpm:<org>` (e.g. the `'mgmt'` limit).
 */
function keyFor(base: 'rpm' | 'day', orgId: number, namespace?: string): string {
  return namespace ? `rl:${namespace}:${base}:${orgId}` : `rl:${base}:${orgId}`;
}
