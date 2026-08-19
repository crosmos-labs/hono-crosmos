import type { Database } from '@crosmos/db';
import type { Env } from '../../bindings';
import { type Entitlements, getEntitlements } from '../../features/orgs/entitlements';
import { DoRateLimiter } from './do';
import { type DeferFn, KvRateLimiter } from './kv';
import { NoopRateLimiter } from './noop';
import { RateLimitError, type RateLimiter } from './port';

export type { RateLimiter, RateLimitCheck, RateLimitScope } from './port';
export type { DeferFn } from './kv';
export { RateLimitError } from './port';

/**
 * Returns the configured rate limiter. Prefers the strongly-consistent
 * `RateLimiterDO` (`RATE_LIMITER` binding) — its counters are in-memory in the
 * DO, so they cost **zero KV puts**. Every authenticated request runs the mgmt
 * limiter, and on the KV path that was ~2–4 puts/request, which blew past the
 * free tier's 1000/day put cap; the DO removes that entire class of writes and
 * also kills the KV limiter's ±1–2 boundary drift.
 *
 * Falls back to {@link KvRateLimiter} when the DO binding is absent (older envs
 * / no binding), then to a no-op (dev/tests). The `defer` scheduler only
 * matters for the KV fallback — it pushes KV writes off the critical path. The
 * DO path awaits its single round-trip (the increment is atomic with the
 * check, so there's no separate write to defer).
 */
export function getRateLimiter(env: Env, defer?: DeferFn): RateLimiter {
  if (env.RATE_LIMITER) {
    // `defer` matters on this path too: when the per-org DO is cold the check is
    // admitted early and the increment is finished on waitUntil.
    return new DoRateLimiter(env.RATE_LIMITER, defer, undefined, env.ENVIRONMENT);
  }
  if (env.API_KEY_CACHE) {
    return new KvRateLimiter(env.API_KEY_CACHE, defer);
  }
  return new NoopRateLimiter();
}

/**
 * Convenience: resolve the org's `rate_limit_rpm` / `rate_limit_per_day`
 * entitlements and run the check. This is the STRICT, AI-path limit — enforced
 * by the search and ingestion gates only (10 RPM on free). Throws
 * `RateLimitError` (which the route translates into 429 + Retry-After).
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

/**
 * The LOOSER management limit (`mgmt_rate_limit_rpm` / `mgmt_rate_limit_per_day`)
 * applied default-on to every authenticated route by `requireAuth`. It uses its
 * own `'mgmt'` counter namespace so it never shares a budget with the strict
 * AI-path limit above — a dashboard fanning out a handful of CRUD calls won't
 * eat into (or be choked by) the search/ingest allowance. Throws
 * `RateLimitError` like its sibling.
 */
export async function enforceMgmtRateLimit(
  db: Database,
  limiter: RateLimiter,
  orgId: number,
  entitlements?: Entitlements,
): Promise<void> {
  const ent = entitlements ?? (await getEntitlements(db, orgId));
  const rpm =
    typeof ent.mgmt_rate_limit_rpm === 'number' ? ent.mgmt_rate_limit_rpm : -1;
  const daily =
    typeof ent.mgmt_rate_limit_per_day === 'number'
      ? ent.mgmt_rate_limit_per_day
      : -1;
  await limiter.check({ orgId, rpmLimit: rpm, dailyLimit: daily, namespace: 'mgmt' });
}

export { RateLimitError as _RateLimitError }; // satisfy bundlers if tree-shaken
