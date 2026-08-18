/**
 * Per-user concurrency limiter — port of Python's `ConcurrencyLimiter`
 * (Redis-backed) onto Cloudflare KV. Bounds concurrent `/search` requests per
 * user. KV is eventually consistent, so the cap
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

/**
 * Outcome of an acquire. `token` identifies the lease this caller now owns and
 * MUST be handed back to `release` — releasing by token means a request can only
 * ever free its own slot. It is `null` when the limiter granted admission
 * without tracking a lease (fail-open paths, the no-op limiter), in which case
 * release is a no-op.
 */
export interface ConcurrencyLease {
  acquired: boolean;
  token: string | null;
}

export interface ConcurrencyLimiter {
  /**
   * Increment + check. `acquired: false` when already at `limit`.
   *
   * `leaseKey` is an optional stable identity for one LOGICAL request. When the
   * backend supports it, re-acquiring with a live `leaseKey` refreshes that
   * lease instead of taking a second slot, so retried copies of one logical
   * recall cannot eat a user's whole concurrency budget. Backends without
   * per-lease identity (KV, no-op) ignore it and behave exactly as before.
   *
   * The key is namespaced under `userKey`, so a caller can only ever collide
   * with its own leases.
   */
  acquire(
    userKey: string,
    limit: number,
    ttlSeconds: number,
    leaseKey?: string,
  ): Promise<ConcurrencyLease>;
  /** Release the lease returned by `acquire`. Always call in a `finally`. */
  release(userKey: string, token: string | null): Promise<void>;
}

/** Admission granted without a tracked lease (fail-open / no-op limiters). */
const UNTRACKED: ConcurrencyLease = { acquired: true, token: null };

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

  async acquire(
    userKey: string,
    limit: number,
    ttlSeconds: number,
    /** Accepted for interface parity and deliberately unused — see below. */
    _leaseKey?: string,
  ): Promise<ConcurrencyLease> {
    const key = PREFIX + userKey;
    try {
      const raw = await this.kv.get(key);
      const current = raw ? Number(raw) : 0;
      if (current >= limit) return { acquired: false, token: null };
      await this.write(key, current + 1, Math.max(KV_MIN_TTL_SECONDS, ttlSeconds));
      // A bare counter has no per-lease identity; the DO limiter is the one that
      // issues tokens — and, for the same reason, the only one that can honour a
      // `leaseKey`. Release still decrements, so this stays correct — just
      // approximate, which is what this fallback has always been.
      return UNTRACKED;
    } catch (err) {
      // Fail open — a KV blip must not 429 real traffic.
      createLogger({ service: 'api' }).error('retrieval.concurrency_acquire_failed', {
        stage: 'concurrency_acquire',
      }, err);
      return UNTRACKED;
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

/**
 * Durable-Object-backed concurrency limiter — strongly consistent, so it does
 * NOT suffer the KV limiter's false-429 drift (KV's deferred, eventually-
 * consistent decrement lags the increment under rapid sequential traffic, so the
 * counter creeps up and rejects requests that aren't actually concurrent).
 *
 * One DO instance per user (`idFromName(`conc:${userId}`)`), separate from the
 * rate limiter's `${bucket}:${ip}` instances of the same class. `acquire` is a
 * single round-trip that atomically checks-and-increments, so it MUST be awaited
 * (~single-digit ms when the DO is co-located with the worker). `release` is
 * fire-and-forget (the route schedules it on `waitUntil`), so it never adds to
 * response latency.
 */
export class DoConcurrencyLimiter implements ConcurrencyLimiter {
  constructor(private readonly ns: DurableObjectNamespace) {}

  private stub(userKey: string): DurableObjectStub {
    const id = this.ns.idFromName(`conc:${userKey}`);
    // `enam` (eastern North America) pins the DO near the prod workers' pinned
    // region (aws:us-east-1), keeping the acquire round-trip intra-region.
    // Honored only at first creation; a no-op on subsequent gets.
    return this.ns.get(id, { locationHint: 'enam' });
  }

  async acquire(
    userKey: string,
    limit: number,
    ttlSeconds: number,
    leaseKey?: string,
  ): Promise<ConcurrencyLease> {
    try {
      const res = await this.stub(userKey).fetch('https://concurrency/acquire', {
        method: 'POST',
        // `leaseKey` is only meaningful here: the DO is the one backend with
        // per-lease identity. It is already namespaced by the `conc:${userKey}`
        // instance, so one user's key can never touch another's slots.
        body: JSON.stringify({ limit, ttlSeconds, leaseKey }),
      });
      const { success, token } = (await res.json()) as {
        success: boolean;
        token?: string;
      };
      return { acquired: success, token: token ?? null };
    } catch (err) {
      // Fail open — a DO blip must not 429 real traffic (matches the KV limiter).
      createLogger({ service: 'api' }).error('retrieval.concurrency_acquire_failed', {
        stage: 'concurrency_acquire',
      }, err);
      return UNTRACKED;
    }
  }

  async release(userKey: string, token: string | null): Promise<void> {
    // No token → nothing was leased (fail-open acquire). Releasing anyway would
    // decrement a slot this request never took, letting a DO blip on acquire
    // silently raise the effective cap for everyone else on this key.
    if (token === null) return;
    try {
      await this.stub(userKey).fetch('https://concurrency/release', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
    } catch (err) {
      createLogger({ service: 'api' }).error('retrieval.concurrency_release_failed', {
        stage: 'concurrency_release',
      }, err);
    }
  }
}

/** Dev/test fallback: always acquires, never blocks. */
export class NoopConcurrencyLimiter implements ConcurrencyLimiter {
  async acquire(): Promise<ConcurrencyLease> {
    return UNTRACKED;
  }
  async release(): Promise<void> {}
}

/**
 * Returns the configured limiter. Prefers the strongly-consistent DO (the
 * `RATE_LIMITER` binding, reused with a `conc:*` key namespace) so bursts of
 * sequential searches don't false-429. Falls back to the KV counter when the DO
 * binding is absent (older envs / no binding), then to a no-op (tests). The KV
 * path still defers its writes via `defer`.
 */
export function getConcurrencyLimiter(env: Env, defer?: DeferFn): ConcurrencyLimiter {
  if (env.RATE_LIMITER) return new DoConcurrencyLimiter(env.RATE_LIMITER);
  if (env.API_KEY_CACHE) return new KvConcurrencyLimiter(env.API_KEY_CACHE, defer);
  return new NoopConcurrencyLimiter();
}
