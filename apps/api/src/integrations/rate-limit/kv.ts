import {
  type RateLimitCheck,
  type RateLimiter,
  RateLimitError,
  type RateLimitScope,
} from './port';

const RPM_PREFIX = 'rl:rpm:';
const DAY_PREFIX = 'rl:day:';

/** Two minutes — keeps the key alive a little past the active window. */
const RPM_TTL_SECONDS = 120;
/** Two days — same idea for the daily bucket. */
const DAY_TTL_SECONDS = 172_800;

/**
 * Cloudflare KV-backed fixed-window limiter.
 *
 * **Tradeoffs.** KV has no atomic increment, so we read-then-write. Two
 * concurrent requests can both read the same N, both write N+1, and we'll
 * undercount by 1. Region replication adds a similar fuzz factor. Per
 * decisions.md §7 we accepted ±1–2 noise on the boundary — the limits we
 * enforce are coarse (10 RPM on free, 300 RPM on pro). When precise
 * enforcement matters (paid-tier abuse), swap to a Durable Object counter.
 *
 * **Fail-open.** Any KV error is logged and the request is allowed —
 * matching Python. We never want infra hiccups to 429 real traffic.
 */
export class KvRateLimiter implements RateLimiter {
  constructor(private readonly kv: KVNamespace) {}

  async check(input: RateLimitCheck): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const minuteBucket = Math.floor(now / 60);
    const dayBucket = Math.floor(now / 86_400);

    try {
      if (input.rpmLimit !== -1) {
        await this.incrementAndCheck(
          `${RPM_PREFIX}${input.orgId}:${minuteBucket}`,
          input.rpmLimit,
          'rpm',
          RPM_TTL_SECONDS,
        );
      }
      if (input.dailyLimit !== -1) {
        await this.incrementAndCheck(
          `${DAY_PREFIX}${input.orgId}:${dayBucket}`,
          input.dailyLimit,
          'day',
          DAY_TTL_SECONDS,
        );
      }
    } catch (err) {
      if (err instanceof RateLimitError) throw err;
      // Any other failure: fail open and log.
      console.error('rate limiter KV failure', err);
    }
  }

  private async incrementAndCheck(
    key: string,
    limit: number,
    scope: RateLimitScope,
    ttlSeconds: number,
  ): Promise<void> {
    const raw = await this.kv.get(key);
    const current = raw ? Number(raw) : 0;
    const next = current + 1;
    // Write-back first so the counter advances even when over-limit (Python
    // increments before checking; we keep the same accounting).
    await this.kv.put(key, String(next), { expirationTtl: ttlSeconds });
    if (next > limit) {
      throw new RateLimitError(scope, limit, next);
    }
  }
}
