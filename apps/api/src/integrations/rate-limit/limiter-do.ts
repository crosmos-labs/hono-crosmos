import { DurableObject } from 'cloudflare:workers';

/**
 * Durable Object with two strongly-consistent limiter roles, dispatched by path:
 *
 *   POST /limit              fixed-window RATE limiter (per `${bucket}:${ip}`)
 *   POST /acquire, /release  per-user CONCURRENCY limiter (in-flight cap)
 *
 * One DO instance per counter key (`idFromName(...)`), so each key has a single,
 * strongly consistent home — exactly what KV (eventually consistent, can't bound
 * a burst) and the experimental `ratelimit` unsafe binding could not provide. A
 * given instance only ever plays one role (its key namespace decides which
 * endpoints are called), so the two pieces of state never mix.
 *
 * All state is in-memory: the DO is single-threaded so increments are race-free,
 * and limiter state is inherently ephemeral, so we don't persist to storage (a
 * rare DO eviction simply resets the counter — fail-open-ish, the right bias for
 * a limiter).
 */
export class RateLimiterDO extends DurableObject {
  // fixed-window rate-limit state, keyed by window name so ONE instance can
  // hold several independent windows (`rpm` and `day` for the same org). Each
  // entry's window = floor(now / windowSeconds).
  private counters = new Map<string, { bucket: number; count: number }>();
  // concurrency state — `lease token -> expiry timestamp (ms)` for in-flight
  // slots. A request that dies without calling /release has its slot expire
  // after ttlSeconds, so leaked slots self-heal (replaces the KV limiter's TTL
  // self-heal) without ever blocking real traffic forever.
  //
  // Keyed by token rather than stored as a bare expiry list so a release frees
  // the caller's OWN slot. The previous implementation released via
  // `slots.shift()` — dropping the oldest entry — which under mixed request
  // durations meant a fast request freed a slow request's still-live lease, and
  // the slow request then freed a third request's. Under the 2026-07-25 load
  // that made effective capacity drift unpredictably in both directions.
  private slots = new Map<string, number>();

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/acquire') return this.acquire(request);
    if (path === '/release') return this.release(request);
    return this.limit(request);
  }

  /**
   * Fixed-window rate limit. Two request shapes:
   *
   *   `{ limit, windowSeconds }`          — one anonymous window
   *   `{ windows: [{ scope, limit, windowSeconds }, ...] }`  — several at once
   *
   * The multi-window form exists so an org's `rpm` and `day` allowances are
   * evaluated in ONE round-trip against one instance, instead of a fetch each
   * to two separate instances. Every gated request paid for both, so this halves
   * the limiter round-trips on the hot path.
   *
   * Counters are independent per `scope`, so combining them changes cost, not
   * enforcement. The caller decides precedence from the per-window results.
   */
  private async limit(request: Request): Promise<Response> {
    const body = await request.json<{
      limit?: number;
      windowSeconds?: number;
      windows?: Array<{ scope: string; limit: number; windowSeconds: number }>;
    }>();
    const now = Math.floor(Date.now() / 1000);

    if (body.windows === undefined) {
      // `count` lets the caller build an accurate RateLimitError / throttle metric.
      const r = this.tick('default', body.limit ?? 0, body.windowSeconds ?? 60, now);
      return Response.json(r);
    }

    const results = body.windows.map((w) => ({
      scope: w.scope,
      ...this.tick(w.scope, w.limit, w.windowSeconds, now),
    }));
    return Response.json({
      success: results.every((r) => r.success),
      results,
    });
  }

  /** Increment one named window and report whether it is still under `limit`. */
  private tick(
    name: string,
    limit: number,
    windowSeconds: number,
    now: number,
  ): { success: boolean; count: number } {
    const bucket = Math.floor(now / windowSeconds);
    const current = this.counters.get(name);
    // Over-limit requests still count toward the window (matches Python).
    const count = current && current.bucket === bucket ? current.count + 1 : 1;
    this.counters.set(name, { bucket, count });
    return { success: count <= limit, count };
  }

  /**
   * Admit an in-flight request iff fewer than `limit` live slots remain, and
   * hand back the lease token that releases it.
   *
   * `leaseKey` (optional) makes acquisition IDEMPOTENT: a caller that re-sends
   * the same logical request reuses its existing lease instead of consuming a
   * second slot. That is what stops a retry storm from eating a user's whole
   * budget with duplicates of one logical recall. It is inert until a client
   * supplies a stable per-recall id — the SDKs do not yet — but the server side
   * is in place so enabling it later needs no DO change.
   */
  private async acquire(request: Request): Promise<Response> {
    const { limit, ttlSeconds, leaseKey } = await request.json<{
      limit: number;
      ttlSeconds: number;
      leaseKey?: string;
    }>();
    const now = Date.now();
    this.purge(now);
    const expiry = now + ttlSeconds * 1000;

    // Same logical request as a live lease → refresh it, don't take a new slot.
    if (leaseKey !== undefined && this.slots.has(leaseKey)) {
      this.slots.set(leaseKey, expiry);
      return Response.json({ success: true, token: leaseKey, reused: true });
    }

    if (this.slots.size >= limit) return Response.json({ success: false });
    const token = leaseKey ?? crypto.randomUUID();
    this.slots.set(token, expiry);
    return Response.json({ success: true, token });
  }

  /**
   * Free the slot identified by `token`. Releasing an unknown or already-expired
   * token is a no-op — a late release can no longer decrement some other
   * request's lease.
   *
   * A tokenless release falls back to dropping the soonest-expiring slot (the
   * old behavior). That path exists only for requests that acquired against a
   * previous version of this class and are still in flight across a deploy;
   * afterwards nothing calls it.
   */
  private async release(request: Request): Promise<Response> {
    const now = Date.now();
    this.purge(now);
    const { token } = await request
      .json<{ token?: string }>()
      .catch(() => ({ token: undefined }));

    if (token !== undefined) {
      return Response.json({ success: this.slots.delete(token) });
    }
    let oldest: string | undefined;
    let oldestExpiry = Infinity;
    for (const [key, exp] of this.slots) {
      if (exp < oldestExpiry) {
        oldestExpiry = exp;
        oldest = key;
      }
    }
    if (oldest !== undefined) this.slots.delete(oldest);
    return Response.json({ success: oldest !== undefined });
  }

  /** Drop leases whose TTL has passed — the self-heal for requests that died. */
  private purge(now: number): void {
    for (const [key, exp] of this.slots) {
      if (exp <= now) this.slots.delete(key);
    }
  }
}
