import { decodeAccessTokenClaims, InvalidTokenError } from './jwt';
import { hashApiKey, isApiKey } from './key-format';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import type { HonoEnv } from '../../bindings';
import { getDb } from '../../db';
import { getCacheStore } from '../../integrations/cache';
import { errorEnvelope } from '../../lib/errors';
import { getCachedEntitlements } from '../../lib/gate-cache';
import { waitUntilLogged } from '../../lib/runtime';
import { createLogger, createMetrics } from '@crosmos/observability';
import {
  enforcePlanRateLimit,
  getRateLimiter,
  RateLimitError,
} from '../../integrations/rate-limit';
import { isAccessTokenRevoked } from './access-revocation';
import {
  resolveApiKeyByHash,
  touchApiKeyLastUsed,
} from './api-keys';
import { getUserById } from './users';

type AuthContext = Context<HonoEnv>;

// API-key auth caches the resolved key in KV to avoid a DB lookup per request.
// The TTL is also the worst-case revocation lag: if the cache-invalidation on
// revoke is ever lost (KV blip), a revoked key keeps working until the entry
// TTLs out. 60s keeps that window tight (was 5 min) while still cutting almost
// all DB lookups. Revoke also actively invalidates the entry (see routes.ts).
const API_KEY_CACHE_TTL_SECONDS = 60;

/**
 * Reject a request as unauthenticated, emitting a structured `auth.failed` log
 * + an `auth_failure` metric first (low-cardinality `reason` + `auth_method`,
 * NEVER the token) so brute-force / credential-stuffing / expired-key churn is
 * observable and alertable. The client message stays generic — in particular
 * JWT-library reasons are collapsed so the 401 isn't an oracle.
 */
function failAuth(
  c: AuthContext,
  reason: string,
  authMethod: 'jwt' | 'api_key' | 'none',
  message: string,
  err?: unknown,
): never {
  createLogger({
    service: 'api',
    environment: c.env.ENVIRONMENT,
    base: { request_id: c.var.requestId },
  }).warn('auth.failed', { reason, auth_method: authMethod, status_code: 401 }, err);
  createMetrics(c.env.ANALYTICS, {
    service: 'api',
    environment: c.env.ENVIRONMENT,
  }).count('auth_failure', { tags: [reason, authMethod], index: 'auth_failure' });
  throw new HTTPException(401, { message });
}

interface CachedApiKey {
  apiKeyId: number;
  apiKeyUuid: string;
  userId: number;
  userUuid: string;
  userEmail: string;
  userName: string;
  orgId: number;
  expiresAt: number | null;
}

function cacheKey(hash: string): string {
  return `apikey:${hash}`;
}

async function authenticateApiKey(c: AuthContext, rawKey: string): Promise<void> {
  const hash = await hashApiKey(rawKey);
  const cache = getCacheStore(c.env);
  const now = Date.now();
  const logger = createLogger({
    service: 'api',
    environment: c.env.ENVIRONMENT,
  });

  let cached = await cache.getJson<CachedApiKey>(cacheKey(hash));

  if (cached && cached.expiresAt != null && cached.expiresAt < now) {
    cached = null;
    waitUntilLogged(
      c,
      logger,
      'auth.api_key_cache_delete_failed',
      cache.delete(cacheKey(hash)),
      { stage: 'api_key_cache_delete' },
    );
  }

  if (!cached) {
    const db = getDb(c);
    const resolved = await resolveApiKeyByHash(db, hash);
    if (!resolved) {
      failAuth(c, 'api_key_invalid', 'api_key', 'Invalid or revoked API key');
    }
    const { apiKey, user } = resolved;
    if (apiKey.expiresAt && apiKey.expiresAt.getTime() < now) {
      failAuth(c, 'api_key_expired', 'api_key', 'API key has expired');
    }
    cached = {
      apiKeyId: apiKey.id,
      apiKeyUuid: apiKey.uuid,
      userId: user.id,
      userUuid: user.uuid,
      userEmail: user.email,
      userName: user.name,
      orgId: apiKey.orgId,
      expiresAt: apiKey.expiresAt ? apiKey.expiresAt.getTime() : null,
    };
    waitUntilLogged(
      c,
      logger,
      'auth.api_key_cache_write_failed',
      cache.putJson(cacheKey(hash), cached, {
        expirationTtlSeconds: API_KEY_CACHE_TTL_SECONDS,
      }),
      { stage: 'api_key_cache_write' },
    );
  }

  // Fire and forget last_used update, but keep failures visible in logs.
  const db = getDb(c);
  waitUntilLogged(
    c,
    logger,
    'auth.api_key_touch_failed',
    touchApiKeyLastUsed(db, cached.apiKeyId),
    { stage: 'api_key_touch' },
  );

  c.set('userId', cached.userId);
  c.set('userUuid', cached.userUuid);
  c.set('userEmail', cached.userEmail);
  c.set('userName', cached.userName);
  c.set('authMethod', 'api_key');
  c.set('apiKeyId', cached.apiKeyId);
  c.set('apiKeyUuid', cached.apiKeyUuid);
  c.set('activeOrgId', cached.orgId);
}

async function authenticateJwt(c: AuthContext, token: string): Promise<void> {
  let claims;
  try {
    claims = await decodeAccessTokenClaims(c.env.JWT_SECRET, token);
  } catch (err) {
    if (err instanceof InvalidTokenError) {
      // Collapse expired/bad-sig/wrong-aud into one generic message so the 401
      // isn't a token-validity oracle; the real reason is logged server-side.
      failAuth(c, 'jwt_invalid', 'jwt', 'Invalid or expired token', err);
    }
    throw err;
  }

  // Reject explicitly-revoked access tokens (e.g. after /logout) before doing
  // any DB work. Tokens minted before jti existed have no jti → nothing to
  // check; their short TTL bounds the exposure.
  if (claims.jti && (await isAccessTokenRevoked(c.env, claims.jti))) {
    failAuth(c, 'jwt_revoked', 'jwt', 'Invalid or expired token');
  }

  const db = getDb(c);
  const user = await getUserById(db, claims.userId);
  if (!user) {
    failAuth(c, 'user_not_found', 'jwt', 'Invalid or expired token');
  }
  if (!user.isActive) {
    failAuth(c, 'user_inactive', 'jwt', 'User account inactive');
  }

  c.set('userId', user.id);
  c.set('userUuid', user.uuid);
  c.set('userEmail', user.email);
  c.set('userName', user.name);
  c.set('authMethod', 'jwt');
  if (claims.activeOrgId != null) {
    c.set('activeOrgId', claims.activeOrgId);
  }
}

function extractBearer(c: AuthContext): string {
  const header = c.req.header('Authorization');
  if (!header || !header.startsWith('Bearer ')) {
    failAuth(c, 'missing_bearer', 'none', 'Missing or malformed Authorization header');
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    failAuth(c, 'empty_bearer', 'none', 'Empty bearer token');
  }
  return token;
}

/**
 * Default-on per-org plan rate limit, run right after authentication for every
 * `requireAuth` route. Previously the plan limiter was opt-in per route, so any
 * new authenticated route shipped *unlimited* by default; baking it into the
 * shared auth gate makes coverage default-on. Routes that still call
 * `enforcePlanRateLimit` themselves set `planRateLimitEnforced` (or observe it)
 * so we never double-count.
 *
 * Only enforces when an org context exists (JWT with `active_org_id`, or an API
 * key — which is always org-pinned). Counter WRITES are deferred via
 * `waitUntil` so this stays off the latency-critical path. Fails **open** on
 * any non-RateLimitError (a KV/entitlements hiccup must not 500 real traffic),
 * matching the limiter's stance elsewhere.
 */
async function enforceOrgPlanRateLimit(c: AuthContext): Promise<void> {
  const orgId = c.var.activeOrgId;
  if (orgId == null || c.var.planRateLimitEnforced) return;

  const db = getDb(c);
  const limiter = getRateLimiter(c.env, (task) => c.executionCtx.waitUntil(task));
  try {
    // Use KV-cached entitlements so the default-on check doesn't add a DB
    // org-fetch to every authenticated request.
    const entitlements = await getCachedEntitlements(c, orgId);
    await enforcePlanRateLimit(db, limiter, orgId, entitlements);
    c.set('planRateLimitEnforced', true);
  } catch (err) {
    if (err instanceof RateLimitError) {
      c.set('planRateLimitEnforced', true);
      createMetrics(c.env.ANALYTICS, {
        service: 'api',
        environment: c.env.ENVIRONMENT,
      }).count('plan_rate_limited', { tags: [err.scope], index: 'plan_rate_limited' });
      const requestId = c.var.requestId;
      const body = new Response(
        JSON.stringify(
          errorEnvelope('Rate limit exceeded', { code: 'rate_limited', requestId }),
        ),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(err.retryAfterSeconds),
            ...(requestId ? { 'X-Request-Id': requestId } : {}),
          },
        },
      );
      throw new HTTPException(429, { res: body });
    }
    // Anything else: fail open (the limiter already swallows KV errors; this
    // guards entitlements-resolution failures too).
    createLogger({ service: 'api', environment: c.env.ENVIRONMENT }).warn(
      'ratelimit.plan_catchall_failure',
      { stage: 'plan_rate_limit', scope: 'org' },
      err,
    );
  }
}

/**
 * Requires either a valid JWT access token or a `csk_…` API key.
 * Populates user/auth context on `c.var`. Does NOT require an org context —
 * for that, chain `requireOrg` after this.
 *
 * Also applies the default-on per-org plan rate limit (see
 * `enforceOrgPlanRateLimit`) so authenticated routes are throttled by default.
 */
export const requireAuth = createMiddleware<HonoEnv>(async (c, next) => {
  const token = extractBearer(c);
  if (isApiKey(token)) {
    await authenticateApiKey(c, token);
  } else {
    await authenticateJwt(c, token);
  }
  await enforceOrgPlanRateLimit(c);
  await next();
});

/**
 * Requires that the request has an org context.
 * API keys are pinned to an org so this is automatic.
 * For JWTs, the access token must carry `active_org_id`.
 */
export const requireOrg = createMiddleware<HonoEnv>(async (c, next) => {
  if (c.var.activeOrgId == null) {
    throw new HTTPException(400, { message: 'no_org_context' });
  }
  await next();
});

export async function invalidateApiKeyCache(
  c: { env: Pick<HonoEnv['Bindings'], 'API_KEY_CACHE'> },
  rawKey: string,
): Promise<void> {
  const hash = await hashApiKey(rawKey);
  await getCacheStore(c.env).delete(cacheKey(hash));
}

export async function invalidateApiKeyCacheByHash(
  env: Pick<HonoEnv['Bindings'], 'API_KEY_CACHE'>,
  hash: string,
): Promise<void> {
  await getCacheStore(env).delete(cacheKey(hash));
}
