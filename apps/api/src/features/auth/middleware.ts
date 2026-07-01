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
  enforceMgmtRateLimit,
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
  // Space scope: the key's pinned space id, or null for an org-wide key.
  spaceId: number | null;
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
      spaceId: apiKey.spaceId ?? null,
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
  if (cached.spaceId != null) c.set('scopedSpaceId', cached.spaceId);
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
 * Default-on per-org MANAGEMENT rate limit, run right after authentication for
 * every `requireAuth` route. This is deliberately the *looser* limit
 * (`mgmt_rate_limit_*`, e.g. 300 RPM on free), kept in its own counter
 * namespace — the strict AI-path limit (`rate_limit_*`, 10 RPM on free) is
 * enforced only by the search and ingestion gates, so normal CRUD/dashboard
 * traffic no longer draws down the tight AI budget. Baking *a* limiter into the
 * shared auth gate keeps coverage default-on: a new authenticated route can't
 * accidentally ship completely unlimited.
 *
 * Only enforces when an org context exists (JWT with `active_org_id`, or an API
 * key — which is always org-pinned). Counter WRITES are deferred via
 * `waitUntil` so this stays off the latency-critical path. Fails **open** on
 * any non-RateLimitError (a KV/entitlements hiccup must not 500 real traffic),
 * matching the limiter's stance elsewhere. Does NOT touch
 * `planRateLimitEnforced` — the AI-path gates own that flag.
 */
async function enforceOrgMgmtRateLimit(c: AuthContext): Promise<void> {
  const orgId = c.var.activeOrgId;
  if (orgId == null || c.var.mgmtRateLimitEnforced) return;

  const db = getDb(c);
  const limiter = getRateLimiter(c.env, (task) => c.executionCtx.waitUntil(task));
  try {
    // Use KV-cached entitlements so the default-on check doesn't add a DB
    // org-fetch to every authenticated request.
    const entitlements = await getCachedEntitlements(c, orgId);
    await enforceMgmtRateLimit(db, limiter, orgId, entitlements);
    c.set('mgmtRateLimitEnforced', true);
  } catch (err) {
    if (err instanceof RateLimitError) {
      c.set('mgmtRateLimitEnforced', true);
      createMetrics(c.env.ANALYTICS, {
        service: 'api',
        environment: c.env.ENVIRONMENT,
      }).count('mgmt_rate_limited', { tags: [err.scope], index: 'mgmt_rate_limited' });
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
      'ratelimit.mgmt_catchall_failure',
      { stage: 'mgmt_rate_limit', scope: 'org' },
      err,
    );
  }
}

/**
 * Data-plane path prefixes a SPACE-SCOPED API key is allowed to reach. A scoped
 * key is meant to be handed to a single end-user's client, so it must be
 * confined to reading/writing memory — never management. Anything outside this
 * list (creating spaces, minting more keys, listing all spaces, org/billing
 * admin) is rejected with 403.
 *
 * Read-side space checks (memories/entities/graph/sources) additionally verify
 * the *specific* space matches the key's scope; this list is the coarse
 * endpoint gate that runs first.
 */
const SCOPED_KEY_ALLOWED_PREFIXES = [
  '/api/v1/sources',
  '/api/v1/search',
  '/api/v1/memories',
  '/api/v1/entities',
  '/api/v1/graph',
  '/api/v1/conversations',
  '/api/v1/jobs', // poll ingestion job status after an ingest
];

/**
 * Reject a space-scoped key on any endpoint outside the data plane. Called from
 * `requireAuth` only when `scopedSpaceId` is set (org-wide keys and JWTs skip
 * this entirely, so nothing about existing behavior changes).
 *
 * A couple of management reads are allowed narrowly: `GET /auth/me` and
 * `GET /auth/keys/validate` (self-introspection), and `GET` on a single space
 * (`/api/v1/spaces/{uuid}` and `/usage`) — but NOT the space *list* or any
 * space mutation.
 */
function enforceScopedKeyEndpoint(c: AuthContext): void {
  const path = c.req.path;
  const method = c.req.method;

  if (SCOPED_KEY_ALLOWED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) {
    return;
  }
  if (method === 'GET' && (path === '/api/v1/auth/me' || path === '/api/v1/auth/keys/validate')) {
    return;
  }
  // GET on a specific space (…/spaces/{uuid} or …/spaces/{uuid}/usage) is fine;
  // the bare collection (…/spaces) and any mutation are not.
  if (method === 'GET' && path.startsWith('/api/v1/spaces/')) {
    return;
  }

  // Authenticated-but-forbidden → 403 (not 401): the key is valid, it just
  // isn't allowed here. Log it as an authorization denial, not an auth failure.
  createLogger({
    service: 'api',
    environment: c.env.ENVIRONMENT,
    base: { request_id: c.var.requestId },
  }).warn('auth.scoped_key_endpoint_denied', {
    reason: 'scoped_key_endpoint_denied',
    auth_method: 'api_key',
    status_code: 403,
    path,
    method,
  });
  throw new HTTPException(403, {
    message: 'This API key is scoped to a single space and cannot access this endpoint.',
  });
}

/**
 * Requires either a valid JWT access token or a `csk_…` API key.
 * Populates user/auth context on `c.var`. Does NOT require an org context —
 * for that, chain `requireOrg` after this.
 *
 * Also applies the default-on per-org management rate limit (see
 * `enforceOrgMgmtRateLimit`) so authenticated routes are throttled by default.
 * The stricter AI-path limit is enforced separately by the search/ingest gates.
 */
export const requireAuth = createMiddleware<HonoEnv>(async (c, next) => {
  const token = extractBearer(c);
  if (isApiKey(token)) {
    await authenticateApiKey(c, token);
  } else {
    await authenticateJwt(c, token);
  }
  // Space-scoped keys are confined to the data plane (must run before the route
  // body so management endpoints are unreachable).
  if (c.var.scopedSpaceId != null) {
    enforceScopedKeyEndpoint(c);
  }
  await enforceOrgMgmtRateLimit(c);
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
