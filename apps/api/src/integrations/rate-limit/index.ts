import type { Database } from '@crosmos/db';
import type { Env } from '../../bindings';
import { type Entitlements, getEntitlements } from '../../features/orgs/entitlements';
import { type DeferFn, KvRateLimiter } from './kv';
import { NoopRateLimiter } from './noop';
import { RateLimitError, type RateLimiter } from './port';

export type { RateLimiter, RateLimitCheck, RateLimitScope } from './port';
export type { DeferFn } from './kv';
export { RateLimitError } from './port';

/**
 * Returns the configured rate limiter. Reuses the API key KV namespace for
 * counters — they live in the same Workers KV store, just under a different
 * key prefix (`rl:*`). If you ever want to separate them, add a second
 * binding and switch the wiring here.
 *
 * Pass `defer` (the request's `waitUntil`) to push the counter writes off the
 * critical path — KV writes are ~350ms from a Smart-Placed worker, so latency-
 * sensitive routes (search) should always supply it. Routes that omit it keep
 * the synchronous (awaited) write behavior.
 */
export function getRateLimiter(env: Env, defer?: DeferFn): RateLimiter {
  if (env.API_KEY_CACHE) {
    return new KvRateLimiter(env.API_KEY_CACHE, defer);
  }
  return new NoopRateLimiter();
}

/**
 * Convenience: resolve the org's `rate_limit_rpm` / `rate_limit_per_day`
 * entitlements and run the check. Throws `RateLimitError` (which the route
 * translates into 429 + Retry-After).
 */
export async function enforcePlanRateLimit(
  db: Database,
  limiter: RateLimiter,
  orgId: number,
  entitlements?: Entitlements,
): Promise<void> {
  const ent = entitlements ?? (await getEntitlements(db, orgId));
  const rpm = typeof ent.rate_limit_rpm === 'number' ? ent.rate_limit_rpm : -1;
  const daily =
    typeof ent.rate_limit_per_day === 'number' ? ent.rate_limit_per_day : -1;
  await limiter.check({ orgId, rpmLimit: rpm, dailyLimit: daily });
}

export { RateLimitError as _RateLimitError }; // satisfy bundlers if tree-shaken
