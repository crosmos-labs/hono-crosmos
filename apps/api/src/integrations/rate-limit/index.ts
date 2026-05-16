import type { Database } from '@crosmos/db';
import type { Env } from '../../bindings';
import { getEntitlements } from '../../features/orgs/entitlements';
import { KvRateLimiter } from './kv';
import { NoopRateLimiter } from './noop';
import { RateLimitError, type RateLimiter } from './port';

export type { RateLimiter, RateLimitCheck, RateLimitScope } from './port';
export { RateLimitError } from './port';

/**
 * Returns the configured rate limiter. Reuses the API key KV namespace for
 * counters — they live in the same Workers KV store, just under a different
 * key prefix (`rl:*`). If you ever want to separate them, add a second
 * binding and switch the wiring here.
 */
export function getRateLimiter(env: Env): RateLimiter {
  if (env.API_KEY_CACHE) {
    return new KvRateLimiter(env.API_KEY_CACHE);
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
): Promise<void> {
  const ent = await getEntitlements(db, orgId);
  const rpm = typeof ent.rate_limit_rpm === 'number' ? ent.rate_limit_rpm : -1;
  const daily =
    typeof ent.rate_limit_per_day === 'number' ? ent.rate_limit_per_day : -1;
  await limiter.check({ orgId, rpmLimit: rpm, dailyLimit: daily });
}

export { RateLimitError as _RateLimitError }; // satisfy bundlers if tree-shaken
