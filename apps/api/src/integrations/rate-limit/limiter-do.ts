import { DurableObject } from 'cloudflare:workers';

/**
 * Durable-Object fixed-window rate limiter. One DO instance per counter key
 * (`idFromName(`${bucket}:${ip}`)`), so each key has a single, strongly
 * consistent home — exactly what KV (eventually consistent, can't bound a
 * burst) and the experimental `ratelimit` unsafe binding (didn't enforce the
 * `simple` limit under a named environment) could not provide.
 *
 * The counter is in-memory: the DO is single-threaded so increments are
 * race-free, and rate-limit state is inherently ephemeral, so we don't persist
 * to storage (a rare DO eviction simply resets the window — fail-open-ish, which
 * is the right bias for a limiter). Window = floor(now / windowSeconds).
 */
export class RateLimiterDO extends DurableObject {
  private windowBucket = 0;
  private count = 0;

  async fetch(request: Request): Promise<Response> {
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
    return Response.json({ success: this.count <= limit });
  }
}
