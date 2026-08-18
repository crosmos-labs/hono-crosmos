import {
  type RateLimitCheck,
  type RateLimiter,
  RateLimitError,
  type RateLimitScope,
} from './port';
import { createLogger } from '@crosmos/observability';

const RPM_PREFIX = 'rl:rpm:';
const DAY_PREFIX = 'rl:day:';

/**
 * Key prefix for a window. A `namespace` segments independent limits for the
 * same org (e.g. `'mgmt'` → `rl:mgmt:rpm:`); omitting it preserves the original
 * `rl:rpm:` / `rl:day:` keys so existing AI-path counters need no migration.
 */
function windowPrefix(base: 'rpm' | 'day', namespace?: string): string {
  return namespace ? `rl:${namespace}:${base}:` : base === 'rpm' ? RPM_PREFIX : DAY_PREFIX;
}

/** Two minutes — keeps the key alive a little past the active window. */
const RPM_TTL_SECONDS = 120;
/** Two days — same idea for the daily bucket. */
const DAY_TTL_SECONDS = 172_800;

/** Schedules a fire-and-forget task (typically `executionCtx.waitUntil`). */
export type DeferFn = (task: Promise<unknown>) => void;

/**
 * Cloudflare KV-backed fixed-window limiter.
 *
 * **Tradeoffs.** KV has no atomic increment, so we read-then-write. Two
 * concurrent requests can both read the same N, both write N+1, and we'll
 * undercount by 1. Region replication adds a similar fuzz factor. Per
 * The limiter accepts small boundary noise; the limits we
 * enforce are coarse (10 RPM on free, 300 RPM on pro). When precise
 * enforcement matters (paid-tier abuse), swap to a Durable Object counter.
 *
 * **Latency.** KV *reads* are edge-cached (~ms) but KV *writes* commit to a
 * central store — from a Smart-Placed worker (co-located with the DB in
 * ap-southeast-1) each `put` is a ~350ms cross-region round-trip. Blocking the
 * request on two such writes (rpm + day) added ~750ms+ to every call. So when a
 * `defer` scheduler is supplied (the request's `waitUntil`), we read both
 * windows in parallel, decide synchronously, and push the increment writes off
 * the critical path. The counter is approximate anyway (see Tradeoffs), and an
 * over-limit request still schedules its write, so the window keeps advancing.
 *
 * **Fail-open.** Any KV error is logged and the request is allowed —
 * matching Python. We never want infra hiccups to 429 real traffic.
 */
export class KvRateLimiter implements RateLimiter {
  constructor(
    private readonly kv: KVNamespace,
    private readonly defer?: DeferFn,
  ) {}

  async check(input: RateLimitCheck): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const minuteBucket = Math.floor(now / 60);
    const dayBucket = Math.floor(now / 86_400);

    const windows: Array<{
      key: string;
      limit: number;
      scope: RateLimitScope;
      ttlSeconds: number;
    }> = [];
    if (input.rpmLimit !== -1) {
      windows.push({
        key: `${windowPrefix('rpm', input.namespace)}${input.orgId}:${minuteBucket}`,
        limit: input.rpmLimit,
        scope: 'rpm',
        ttlSeconds: RPM_TTL_SECONDS,
      });
    }
    if (input.dailyLimit !== -1) {
      windows.push({
        key: `${windowPrefix('day', input.namespace)}${input.orgId}:${dayBucket}`,
        limit: input.dailyLimit,
        scope: 'day',
        ttlSeconds: DAY_TTL_SECONDS,
      });
    }
    if (windows.length === 0) return;

    try {
      // Read both windows in parallel — KV reads are edge-cached, so this is the
      // only latency the request actually pays.
      const currents = await Promise.all(
        windows.map(async (w) => {
          const raw = await this.kv.get(w.key);
          return raw ? Number(raw) : 0;
        }),
      );
      // Schedule every increment (even over-limit ones — the window must keep
      // advancing, matching Python's increment-before-check), then enforce.
      let exceeded: RateLimitError | null = null;
      const writes: Array<Promise<unknown>> = [];
      windows.forEach((w, i) => {
        const next = currents[i]! + 1;
        writes.push(this.scheduleWrite(w.key, next, w.ttlSeconds));
        if (next > w.limit && exceeded === null) {
          exceeded = new RateLimitError(w.scope, w.limit, next);
        }
      });
      // No scheduler (e.g. routes that don't pass `waitUntil`): keep the old
      // contract and await the writes before returning so they can't be lost to
      // worker teardown. With a scheduler, `defer` already owns their lifetime.
      if (!this.defer) await Promise.all(writes);
      if (exceeded) throw exceeded;
    } catch (err) {
      if (err instanceof RateLimitError) throw err;
      // Any other failure: fail open and log.
      createLogger({ service: 'api' }).error('rate_limit.kv_failure', {
        org_id: input.orgId,
        stage: 'rate_limit_check',
      }, err);
    }
  }

  /**
   * Commit the counter. With a `defer` scheduler the write runs in the
   * background (off the request's critical path); without one we await it so
   * the write still lands before the worker can be torn down.
   */
  private scheduleWrite(key: string, value: number, ttlSeconds: number): Promise<unknown> {
    const write = this.kv
      .put(key, String(value), { expirationTtl: ttlSeconds })
      .catch((err) =>
        createLogger({ service: 'api' }).error('rate_limit.kv_write_failed', {
          stage: 'rate_limit_write',
        }, err),
      );
    if (this.defer) this.defer(write);
    return write;
  }
}
