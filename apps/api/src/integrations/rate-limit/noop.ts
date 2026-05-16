import type { RateLimitCheck, RateLimiter } from './port';

/**
 * No-op rate limiter. Useful in tests and local development where you don't
 * want a KV namespace bound. Selected by the factory when an explicit
 * `RATE_LIMIT_DISABLED=true` flag is set, or as a fallback if no KV binding
 * is available.
 */
export class NoopRateLimiter implements RateLimiter {
  async check(_input: RateLimitCheck): Promise<void> {
    // intentionally empty
  }
}
