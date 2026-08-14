import { createMetrics } from '@crosmos/observability';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { MiddlewareHandler } from 'hono';
import type { AdminEnv } from './bindings';

const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function reject(c: Parameters<MiddlewareHandler<AdminEnv>>[0], reason: string) {
  createMetrics(c.env.ANALYTICS, {
    service: 'admin', environment: c.env.ENVIRONMENT,
    version: c.env.CF_VERSION_METADATA?.id,
  }).count('admin_auth_failure', { tags: [reason], index: 'admin_auth' });
  return c.json({ detail: 'Forbidden', request_id: c.var.requestId }, 403);
}

export const requireAdmin: MiddlewareHandler<AdminEnv> = async (c, next) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const id = c.env.ADMIN_RATE_LIMITER.idFromName(ip);
  const limit = Math.max(1, Number(c.env.ADMIN_RATE_LIMIT_PER_MINUTE ?? '60'));
  const throttle = await c.env.ADMIN_RATE_LIMITER.get(id).fetch('https://limiter/check', {
    method: 'POST', body: JSON.stringify({ limit }),
  }).then((response) => response.json<{ allowed: boolean }>());
  if (!throttle.allowed) return reject(c, 'rate_limited');

  const token = c.req.header('Cf-Access-Jwt-Assertion');
  if (!token) return reject(c, 'missing_access_jwt');
  const issuer = `https://${c.env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
  try {
    let keySet = jwks.get(issuer);
    if (!keySet) {
      keySet = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
      jwks.set(issuer, keySet);
    }
    const verified = await jwtVerify(token, keySet, {
      issuer, audience: c.env.ACCESS_AUD,
    });
    const email = typeof verified.payload.email === 'string'
      ? verified.payload.email.trim().toLowerCase() : '';
    const allowed = new Set(c.env.ADMIN_ALLOWED_EMAILS.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean));
    if (!email || !allowed.has(email)) return reject(c, 'email_not_allowed');
    c.set('actorEmail', email);
  } catch {
    return reject(c, 'invalid_access_jwt');
  }
  await next();
};
