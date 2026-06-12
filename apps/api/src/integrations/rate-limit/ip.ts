import { createLogger } from '@crosmos/observability';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import type { HonoEnv } from '../../bindings';
import { errorEnvelope } from '../../lib/errors';

/**
 * Per-IP fixed-window rate limiter, as Hono middleware. The plan rate limiter
 * (`enforcePlanRateLimit`) is keyed on `orgId` and therefore CANNOT protect
 * endpoints that run *before* an org context exists — unauthenticated auth and
 * OAuth routes. This fills that gap: it keys on `cf-connecting-ip` so anonymous
 * floods (token-guessing, `/oauth/register` spam, DB-amplification) are bounded
 * before the route touches the DB or fans out to an upstream.
 *
 * Backed by the same KV namespace as the plan limiter, under an `rl:ip:` prefix.
 *
 * **Counting.** Unlike the latency-critical plan limiter (which defers writes
 * off the request path), this AWAITS the increment before deciding. These
 * endpoints are low-volume and not latency-sensitive, and accurate counting
 * matters more here (brute-force protection), so we accept the ~one KV write of
 * latency rather than the deferred-write under-count.
 *
 * **Fail-open.** A KV error logs and allows the request — an infra hiccup must
 * not lock everyone out of login. (Cloudflare's edge still provides baseline
 * L3/L7 DoS protection in front of the worker.)
 */
export interface IpRateLimitOptions {
  /** Logical bucket name, namespaces the counter (e.g. 'auth', 'oauth-register'). */
  bucket: string;
  /** Max requests allowed per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

const IP_PREFIX = 'rl:ip:';

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

export function perIpRateLimit(opts: IpRateLimitOptions) {
  return createMiddleware<HonoEnv>(async (c, next) => {
    const kv = c.env.API_KEY_CACHE;
    const ip = clientIp(c);
    // No KV binding (dev/tests) or no resolvable IP → can't limit; allow.
    if (!kv || ip === 'unknown') {
      await next();
      return;
    }

    const logger = createLogger({ service: 'api', environment: c.env.ENVIRONMENT });
    try {
      const now = Math.floor(Date.now() / 1000);
      const windowBucket = Math.floor(now / opts.windowSeconds);
      const key = `${IP_PREFIX}${opts.bucket}:${ip}:${windowBucket}`;
      const raw = await kv.get(key);
      const current = raw ? Number(raw) : 0;
      const next1 = current + 1;
      // Keep the key alive a little past the window so late requests still count.
      await kv.put(key, String(next1), {
        expirationTtl: Math.max(60, opts.windowSeconds * 2),
      });
      if (next1 > opts.limit) {
        logger.warn('ratelimit.ip_exceeded', {
          reason: opts.bucket,
          ip,
          limit: opts.limit,
          count: next1,
          scope: 'ip',
        });
        const requestId = c.var.requestId;
        const res = new Response(
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
              'Retry-After': String(opts.windowSeconds),
              ...(requestId ? { 'X-Request-Id': requestId } : {}),
            },
          },
        );
        throw new HTTPException(429, { res });
      }
    } catch (err) {
      if (err instanceof HTTPException) throw err;
      // Any KV failure: fail open and log, matching the plan limiter's stance.
      createLogger({ service: 'api', environment: c.env.ENVIRONMENT }).warn(
        'ratelimit.ip_kv_failure',
        { reason: opts.bucket, stage: 'ip_rate_limit' },
        err,
      );
    }
    await next();
  });
}
