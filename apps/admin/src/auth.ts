import { createMetrics } from '@crosmos/observability';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { MiddlewareHandler } from 'hono';
import type { AdminEnv } from './bindings';
import { getAdminConfig } from './config';

const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function reject(c: Parameters<MiddlewareHandler<AdminEnv>>[0], reason: string) {
  createMetrics(c.env.ANALYTICS, {
    service: 'admin', environment: c.env.ENVIRONMENT,
    version: c.env.CF_VERSION_METADATA?.id,
  }).count('admin_auth_failure', { tags: [reason], index: 'admin_auth' });
  return c.json({ detail: 'Forbidden', request_id: c.var.requestId }, 403);
}

export const requireAdmin: MiddlewareHandler<AdminEnv> = async (c, next) => {
  const config = getAdminConfig(c.env);
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const id = c.env.ADMIN_RATE_LIMITER.idFromName(ip);
  const throttle = await c.env.ADMIN_RATE_LIMITER.get(id).fetch('https://limiter/check', {
    method: 'POST', body: JSON.stringify({ limit: config.rateLimitPerMinute }),
  }).then((response) => response.json<{ allowed: boolean }>());
  if (!throttle.allowed) return reject(c, 'rate_limited');

  const token = c.req.header('Cf-Access-Jwt-Assertion');
  if (!token) return reject(c, 'missing_access_jwt');
  const issuer = `https://${config.accessTeamDomain}`;
  try {
    let keySet = jwks.get(issuer);
    if (!keySet) {
      keySet = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
      jwks.set(issuer, keySet);
    }
    const verified = await jwtVerify(token, keySet, {
      issuer, audience: config.accessAudience,
    });
    const email = typeof verified.payload.email === 'string'
      ? verified.payload.email.trim().toLowerCase() : '';
    if (!email || !config.allowedEmails.has(email)) return reject(c, 'email_not_allowed');
    c.set('actorEmail', email);
  } catch {
    return reject(c, 'invalid_access_jwt');
  }
  await next();
};
