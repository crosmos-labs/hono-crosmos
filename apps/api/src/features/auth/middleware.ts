import { decodeAccessTokenClaims, InvalidTokenError } from './jwt';
import { hashApiKey, isApiKey } from './key-format';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import type { HonoEnv } from '../../bindings';
import { getDb } from '../../db';
import {
  resolveApiKeyByHash,
  touchApiKeyLastUsed,
} from './api-keys';
import { getUserById } from './users';

type AuthContext = Context<HonoEnv>;

const API_KEY_CACHE_TTL_SECONDS = 5 * 60;

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
  const cache = c.env.API_KEY_CACHE;
  const now = Date.now();

  let cached = (await cache.get(cacheKey(hash), 'json')) as CachedApiKey | null;

  if (cached && cached.expiresAt != null && cached.expiresAt < now) {
    cached = null;
    // Don't await — best-effort eviction
    c.executionCtx.waitUntil(cache.delete(cacheKey(hash)));
  }

  if (!cached) {
    const db = getDb(c);
    const resolved = await resolveApiKeyByHash(db, hash);
    if (!resolved) {
      throw new HTTPException(401, { message: 'Invalid or revoked API key' });
    }
    const { apiKey, user } = resolved;
    if (apiKey.expiresAt && apiKey.expiresAt.getTime() < now) {
      throw new HTTPException(401, { message: 'API key has expired' });
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
    c.executionCtx.waitUntil(
      cache.put(cacheKey(hash), JSON.stringify(cached), {
        expirationTtl: API_KEY_CACHE_TTL_SECONDS,
      }),
    );
  }

  // Fire and forget last_used update
  const db = getDb(c);
  c.executionCtx.waitUntil(touchApiKeyLastUsed(db, cached.apiKeyId));

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
      throw new HTTPException(401, { message: err.message });
    }
    throw err;
  }

  const db = getDb(c);
  const user = await getUserById(db, claims.userId);
  if (!user) {
    throw new HTTPException(401, { message: 'User not found' });
  }
  if (!user.isActive) {
    throw new HTTPException(401, { message: 'User account inactive' });
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
    throw new HTTPException(401, { message: 'Missing or malformed Authorization header' });
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    throw new HTTPException(401, { message: 'Empty bearer token' });
  }
  return token;
}

/**
 * Requires either a valid JWT access token or a `csk_…` API key.
 * Populates user/auth context on `c.var`. Does NOT require an org context —
 * for that, chain `requireOrg` after this.
 */
export const requireAuth = createMiddleware<HonoEnv>(async (c, next) => {
  const token = extractBearer(c);
  if (isApiKey(token)) {
    await authenticateApiKey(c, token);
  } else {
    await authenticateJwt(c, token);
  }
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
  c: { env: { API_KEY_CACHE: KVNamespace }; executionCtx: ExecutionContext },
  rawKey: string,
): Promise<void> {
  const hash = await hashApiKey(rawKey);
  await c.env.API_KEY_CACHE.delete(cacheKey(hash));
}

export async function invalidateApiKeyCacheByHash(
  env: { API_KEY_CACHE: KVNamespace },
  hash: string,
): Promise<void> {
  await env.API_KEY_CACHE.delete(cacheKey(hash));
}
