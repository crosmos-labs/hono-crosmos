import { createLogger } from '@crosmos/observability';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import type { HonoEnv } from '../../bindings';
import { hmacSha256Hex } from '../../lib/crypto';
import { errorEnvelope } from '../../lib/errors';

/**
 * Per-IP rate limiter, as Hono middleware. The plan rate limiter
 * (`enforcePlanRateLimit`) is keyed on `orgId` and therefore CANNOT protect
 * endpoints that run *before* an org context exists — unauthenticated auth and
 * OAuth routes. This fills that gap, keyed on `cf-connecting-ip`, so anonymous
 * floods (token-guessing, `/oauth/register` spam, DB-amplification) are bounded
 * before the route touches the DB or fans out to an upstream.
 *
 * Backed by a Durable Object (`RATE_LIMITER`, class `RateLimiterDO`): one DO per
 * `${bucket}:${ip}` key gives a strongly consistent counter. KV is eventually
 * consistent (a burst never accumulates) and the experimental `ratelimit` unsafe
 * binding did not enforce its `simple` limit under a named env — verified live —
 * so neither could bound a burst. The DO can.
 *
 * Two tiers map to two limits:
 *   - `standard` → 30 / 60s   (refresh/logout/oauth flows)
 *   - `strict`   → 5 / 60s    (row-creating `/oauth/register`)
 *
 * **Fail-open.** If the DO binding is unbound (local dev) or errors, the request
 * is allowed — an infra hiccup must not lock everyone out of login. Cloudflare's
 * edge still provides baseline L3/L7 DoS protection in front of the worker.
 */
export type RateLimitTier = 'standard' | 'strict';

const TIER_LIMITS: Record<RateLimitTier, { limit: number; windowSeconds: number }> = {
  standard: { limit: 30, windowSeconds: 60 },
  strict: { limit: 5, windowSeconds: 60 },
};

export interface IpRateLimitOptions {
  /** Logical bucket name; namespaces the counter per endpoint. */
  bucket: string;
  /** Which limit tier to apply. */
  tier: RateLimitTier;
  /**
   * Fail **closed** when the limiter can't make a decision (the DO binding is
   * present but errors). Use for high-value pre-auth buckets where an
   * un-throttled flood is worse than briefly rejecting traffic (e.g.
   * `/oauth/register`, API-key creation). Defaults to false (fail open). A
   * fully-absent binding (local dev/tests) still fails open regardless, so
   * development isn't blocked.
   */
  failClosed?: boolean;
}

function clientIp(c: { req: { header(name: string): string | undefined } }): string {
  const direct = c.req.header('cf-connecting-ip');
  if (direct) return direct;
  const fwd = c.req.header('x-forwarded-for');
  if (fwd) {
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  return 'unknown';
}

/**
 * Pseudonymize an address only for durable logs. The rate-limit DO key keeps
 * using the raw address so rotating the secret never resets live counters.
 * Missing configuration fails private: the identifying field is omitted.
 */
export async function hashIpForLog(
  secret: string | undefined,
  ip: string,
): Promise<string | undefined> {
  if (!secret) return undefined;
  return (await hmacSha256Hex(secret, ip)).slice(0, 16);
}

export function perIpRateLimit(opts: IpRateLimitOptions) {
  const { limit, windowSeconds } = TIER_LIMITS[opts.tier];
  return createMiddleware<HonoEnv>(async (c, next) => {
    const ns = c.env.RATE_LIMITER;
    const ip = clientIp(c);
    // No binding (dev/tests) or no resolvable IP → can't limit; allow.
    if (!ns || ip === 'unknown') {
      await next();
      return;
    }

    try {
      const id = ns.idFromName(`${opts.bucket}:${ip}`);
      const stub = ns.get(id);
      const res = await stub.fetch('https://rate-limiter/limit', {
        method: 'POST',
        body: JSON.stringify({ limit, windowSeconds }),
      });
      const { success } = (await res.json()) as { success: boolean };
      if (!success) {
        const ipHash = await hashIpForLog(c.env.LOG_IP_HASH_SALT, ip);
        createLogger({ service: 'api', environment: c.env.ENVIRONMENT }).warn(
          'ratelimit.ip_exceeded',
          {
            reason: opts.bucket,
            ...(ipHash ? { ip_hash: ipHash } : {}),
            limit,
            scope: 'ip',
          },
        );
        const requestId = c.var.requestId;
        const body = new Response(
          JSON.stringify(
            errorEnvelope('Too many requests', { code: 'ip_rate_limited', requestId }),
          ),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': String(windowSeconds),
              ...(requestId ? { 'X-Request-Id': requestId } : {}),
            },
          },
        );
        throw new HTTPException(429, { res: body });
      }
    } catch (err) {
      if (err instanceof HTTPException) throw err;
      // DO failure: log, then fail open OR closed per the bucket's policy. The
      // strict pre-auth buckets fail closed so a degraded limiter can't silently
      // disable throttling on the highest-value endpoints.
      createLogger({ service: 'api', environment: c.env.ENVIRONMENT }).warn(
        'ratelimit.ip_do_failure',
        { reason: opts.bucket, stage: 'ip_rate_limit', fail_closed: opts.failClosed === true },
        err,
      );
      if (opts.failClosed) {
        const requestId = c.var.requestId;
        const body = new Response(
          JSON.stringify(
            errorEnvelope('Too many requests', {
              code: 'ip_rate_limited',
              requestId,
            }),
          ),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': String(windowSeconds),
              ...(requestId ? { 'X-Request-Id': requestId } : {}),
            },
          },
        );
        throw new HTTPException(429, { res: body });
      }
    }
    await next();
  });
}
