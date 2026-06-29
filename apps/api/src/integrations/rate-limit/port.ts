/**
 * Per-org plan rate limiter. Two fixed-window counters: RPM (per minute) and
 * per-day. Both must fit for the request to be allowed. Limits come from the
 * org's resolved entitlements (`rate_limit_rpm`, `rate_limit_per_day`); `-1`
 * means uncapped — that window is skipped entirely.
 *
 * Mirrors Python's `PlanRateLimiter` in `app/middleware/rate_limit.py`.
 *
 * Implementations: see `./kv.ts` (Cloudflare KV) and `./noop.ts` (dev/tests).
 * Routes get one via `getRateLimiter(env)` in `./index.ts`.
 */
export interface RateLimitCheck {
  orgId: number;
  rpmLimit: number;
  dailyLimit: number;
  /**
   * Optional key-namespace so independent limits for the same org don't share
   * a counter. Omitted = the default (AI-path) counter (`rl:rpm:*`, `rl:day:*`),
   * unchanged from before. `'mgmt'` keys the looser per-route management limit
   * under `rl:mgmt:rpm:*` / `rl:mgmt:day:*`.
   */
  namespace?: string;
}

export type RateLimitScope = 'rpm' | 'day';

export class RateLimitError extends Error {
  constructor(
    public readonly scope: RateLimitScope,
    public readonly limit: number,
    public readonly count: number,
  ) {
    super(`Rate limit exceeded: ${scope} ${count}/${limit}`);
    this.name = 'RateLimitError';
  }

  /** Retry-After header value matching Python: 60 for rpm, 3600 for daily. */
  get retryAfterSeconds(): number {
    return this.scope === 'rpm' ? 60 : 3600;
  }
}

export interface RateLimiter {
  /**
   * Throws `RateLimitError` when the request is over a limit. Increments
   * counters on every call (so over-limit requests still count toward the
   * window — matches Python). Fails **open** on backend errors: a KV blip
   * must not break paying users.
   */
  check(input: RateLimitCheck): Promise<void>;
}
