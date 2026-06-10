/**
 * Per-user concurrency limiter — port of Python's `ConcurrencyLimiter`
 * (Redis-backed) onto Cloudflare KV. Bounds concurrent `/search` requests per
 * user (decisions.md §4 + worker.md). KV is eventually consistent, so the cap
 * is approximate (±1–2) — acceptable; it's an abuse guard, not a billing gate.
 *
 * The TTL is a self-healing net: a request that dies without releasing has its
 * slot expire automatically.
 *
 * ⚠️ Cloudflare KV enforces a 60s minimum `expirationTtl`. The Python constant
 * is 30s; we floor to 60s. This only affects how fast a leaked slot self-heals
 * (60s vs 30s) — the counter check itself is unchanged.
 */
import { createLogger } from '@crosmos/observability';
import type { Env } from '../../bindings';
import { RETRIEVAL_USER_COUNTER_TTL_SECONDS } from './constants';

const PREFIX = 'retrieval:concurrency:';
const KV_MIN_TTL_SECONDS = 60;

/** Schedules a fire-and-forget task (typically `executionCtx.waitUntil`). */
export type DeferFn = (task: Promise<unknown>) => void;

export interface ConcurrencyLimiter {
  /** Increment + check. Returns false when already at `limit`. */
  acquire(userKey: string, limit: number, ttlSeconds: number): Promise<boolean>;
  /** Decrement (floor 0). Always call in a `finally`. */
  release(userKey: string): Promise<void>;
}

/**
 * KV-backed per-user concurrency counter.
 *
 * **Latency.** Like the rate limiter, KV *writes* commit cross-region (~350ms
 * from a Smart-Placed worker) while reads are edge-cached. The counter is an
 * approximate abuse guard (±1–2 already accepted; the TTL self-heals leaks), so
 * when a `defer` scheduler is supplied we make the acquire/check decision off
 * the read alone and push the increment/decrement writes to `waitUntil`. This
 * removes ~350ms from `acquire` AND ~350ms from `release` (the latter ran in a
 * `finally` and blocked the response without showing up in `took_ms`).
 */
export class KvConcurrencyLimiter implements ConcurrencyLimiter {
  constructor(
    private readonly kv: KVNamespace,
    private readonly defer?: DeferFn,
  ) {}

  async acquire(userKey: string, limit: number, ttlSeconds: number): Promise<boolean> {
    const key = PREFIX + userKey;
    try {
      const raw = await this.kv.get(key);
      const current = raw ? Number(raw) : 0;
      if (current >= limit) return false;
      await this.write(key, current + 1, Math.max(KV_MIN_TTL_SECONDS, ttlSeconds));
      return true;
    } catch (err) {
      // Fail open — a KV blip must not 429 real traffic.
      createLogger({ service: 'api' }).error('retrieval.concurrency_acquire_failed', {
        stage: 'concurrency_acquire',
      }, err);
      return true;
    }
  }

  async release(userKey: string): Promise<void> {
    const key = PREFIX + userKey;
    try {
      const raw = await this.kv.get(key);
      const current = raw ? Number(raw) : 0;
      const next = Math.max(0, current - 1);
      await this.write(key, next, Math.max(KV_MIN_TTL_SECONDS, RETRIEVAL_USER_COUNTER_TTL_SECONDS));
    } catch (err) {
      createLogger({ service: 'api' }).error('retrieval.concurrency_release_failed', {
        stage: 'concurrency_release',
      }, err);
    }
  }

  /** Defer the write when a scheduler is set; otherwise await it (old behavior). */
  private async write(key: string, value: number, ttlSeconds: number): Promise<void> {
    const put = this.kv.put(key, String(value), { expirationTtl: ttlSeconds });
    if (this.defer) {
      this.defer(
        put.catch((err) =>
          createLogger({ service: 'api' }).error('retrieval.concurrency_write_failed', {
            stage: 'concurrency_write',
          }, err),
        ),
      );
      return;
    }
    await put;
  }
}

/** Dev/test fallback: always acquires, never blocks. */
export class NoopConcurrencyLimiter implements ConcurrencyLimiter {
  async acquire(): Promise<boolean> {
    return true;
  }
  async release(): Promise<void> {}
}

/**
 * Returns the configured limiter. Reuses the API-key KV namespace (counters
 * live under the `retrieval:concurrency:*` prefix) — same wiring as the
 * ingestion rate limiter.
 */
export function getConcurrencyLimiter(env: Env, defer?: DeferFn): ConcurrencyLimiter {
  if (env.API_KEY_CACHE) return new KvConcurrencyLimiter(env.API_KEY_CACHE, defer);
  return new NoopConcurrencyLimiter();
}
