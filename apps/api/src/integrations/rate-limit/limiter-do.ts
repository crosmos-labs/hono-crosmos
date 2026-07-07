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
  // fixed-window rate-limit state — window = floor(now / windowSeconds).
  private windowBucket = 0;
  private count = 0;
  // concurrency state — expiry timestamps (ms) of in-flight slots. A request
  // that dies without calling /release has its slot expire after ttlSeconds, so
  // leaked slots self-heal (replaces the KV limiter's TTL self-heal) without
  // ever blocking real traffic forever.
  private slots: number[] = [];

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/acquire') return this.acquire(request);
    if (path === '/release') return this.release();
    return this.limit(request);
  }

  private async limit(request: Request): Promise<Response> {
    const { limit, windowSeconds } = await request.json<{
      limit: number;
      windowSeconds: number;
    }>();
    const now = Math.floor(Date.now() / 1000);
    const bucket = Math.floor(now / windowSeconds);
    if (bucket !== this.windowBucket) {
      this.windowBucket = bucket;
      this.count = 0;
    }
    this.count += 1;
    // `count` lets the caller build an accurate RateLimitError / throttle metric.
    return Response.json({ success: this.count <= limit, count: this.count });
  }

  /** Admit an in-flight request iff fewer than `limit` live slots remain. */
  private async acquire(request: Request): Promise<Response> {
    const { limit, ttlSeconds } = await request.json<{
      limit: number;
      ttlSeconds: number;
    }>();
    const now = Date.now();
    this.slots = this.slots.filter((exp) => exp > now); // purge leaked/expired
    if (this.slots.length >= limit) return Response.json({ success: false });
    this.slots.push(now + ttlSeconds * 1000);
    return Response.json({ success: true });
  }

  /** Free one in-flight slot. Untracked (no per-request token) — drops the
   *  oldest; under roughly-FIFO traffic that's the releasing request, and the
   *  TTL bounds any drift. No-op when already empty. */
  private release(): Response {
    const now = Date.now();
    this.slots = this.slots.filter((exp) => exp > now);
    this.slots.shift();
    return Response.json({ success: true });
  }
}
