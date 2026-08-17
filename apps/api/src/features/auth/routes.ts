import {
  createAccessToken,
  createTokenPair,
  decodeAccessTokenClaims,
  decodeRefreshTokenClaims,
  InvalidTokenError,
} from './jwt';
import { revokeAccessToken } from './access-revocation';
import {
  ApiKeyCreatedSchema,
  ApiKeyListResponseSchema,
  ApiKeyValidateResponseSchema,
  CreateApiKeySchema,
  LogoutRequestSchema,
  RefreshRequestSchema,
  SetActiveOrgResponseSchema,
  SetActiveOrgSchema,
  TokenPairSchema,
  UpdateUserSchema,
  UserSchema,
} from './schemas';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { createApiApp } from '../../lib/openapi';
import { PaginationQuerySchema } from '../../lib/zod-common';
import { createLogger } from '@crosmos/observability';
import { HTTPException } from 'hono/http-exception';
import type { HonoEnv } from '../../bindings';
import { getDb } from '../../db';
import { perIpRateLimit } from '../../integrations/rate-limit/ip';
import { invalidateApiKeyCacheByHash, requireAuth } from './middleware';
import { requirePrincipal } from './principal';
import {
  createApiKey,
  getApiKeyByUuid,
  listApiKeysForUser,
  revokeApiKey,
} from './api-keys';
import {
  getEarliestMembershipForUser,
  getMembership,
} from '../orgs/memberships';
import {
  getOrganizationByIdOrThrow,
  resolveOrgIdFromUuid,
} from '../orgs/service';
import { getSpaceByUuid } from '../spaces/service';
import {
  revokeRefreshToken,
  revokeRefreshTokenIfActive,
} from './refresh-tokens';
import { getUserById, updateUserName } from './users';

export const authRoutes = createApiApp();

const ErrorBody = z
  .object({ detail: z.string() })
  .openapi('ErrorBody');

const errorResponses = {
  401: {
    description: 'Unauthorized',
    content: { 'application/json': { schema: ErrorBody } },
  },
  404: {
    description: 'Not found',
    content: { 'application/json': { schema: ErrorBody } },
  },
};

// ---------------- /me ----------------

authRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/me',
    tags: ['auth'],
    summary: 'Get current user',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requirePrincipal] as const,
    responses: {
      200: {
        description: 'Current user',
        content: { 'application/json': { schema: UserSchema } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const db = getDb(c);
    const org = c.var.activeOrgId
      ? await getOrganizationByIdOrThrow(db, c.var.activeOrgId)
      : null;
    return c.json(
      {
        user_id: c.var.userUuid!,
        email: c.var.userEmail!,
        name: c.var.userName!,
        org: org
          ? {
              id: org.uuid,
              slug: org.slug,
              name: org.name,
              role: c.var.orgRole!,
            }
          : null,
      },
      200,
    );
  },
);

authRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/me',
    tags: ['auth'],
    summary: 'Update current user',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requirePrincipal] as const,
    request: {
      body: {
        content: { 'application/json': { schema: UpdateUserSchema } },
      },
    },
    responses: {
      200: {
        description: 'Updated user',
        content: { 'application/json': { schema: UserSchema } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const body = c.req.valid('json');
    const db = getDb(c);
    if (body.name) {
      const updated = await updateUserName(db, c.var.userId!, body.name);
      if (!updated) throw new HTTPException(404, { message: 'User not found' });
      const org = c.var.activeOrgId
        ? await getOrganizationByIdOrThrow(db, c.var.activeOrgId)
        : null;
      return c.json({
        user_id: updated.uuid,
        email: updated.email,
        name: updated.name,
        org: org
          ? { id: org.uuid, slug: org.slug, name: org.name, role: c.var.orgRole! }
          : null,
      }, 200);
    }
    const user = await getUserById(db, c.var.userId!);
    if (!user) throw new HTTPException(404, { message: 'User not found' });
    const org = c.var.activeOrgId
      ? await getOrganizationByIdOrThrow(db, c.var.activeOrgId)
      : null;
    return c.json({
      user_id: user.uuid,
      email: user.email,
      name: user.name,
      org: org
        ? { id: org.uuid, slug: org.slug, name: org.name, role: c.var.orgRole! }
        : null,
    }, 200);
  },
);

authRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/active-org',
    tags: ['auth'],
    summary: 'Switch active organization',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth] as const,
    request: {
      body: { content: { 'application/json': { schema: SetActiveOrgSchema } } },
    },
    responses: {
      200: {
        description: 'New access token',
        content: { 'application/json': { schema: SetActiveOrgResponseSchema } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const { org_id } = c.req.valid('json');
    const db = getDb(c);
    const orgId = await resolveOrgIdFromUuid(db, org_id);
    if (orgId == null || !(await getMembership(db, orgId, c.var.userId!))) {
      throw new HTTPException(404, { message: 'Organization not found' });
    }
    const token = await createAccessToken(c.env.JWT_SECRET, c.var.userId!, {
      activeOrgId: orgId,
    });
    return c.json({ access_token: token, active_org_id: org_id }, 200);
  },
);

// ---------------- /keys ----------------

authRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/keys',
    tags: ['auth'],
    summary: 'Create API key',
    security: [{ bearerAuth: [] }],
    middleware: [
      // Per-IP strict cap on key creation (each call writes an api_keys row),
      // in front of auth. Fails closed for the same reason as /oauth/register.
      perIpRateLimit({ bucket: 'api-key-create', tier: 'strict', failClosed: true }),
      requireAuth,
      requirePrincipal,
    ] as const,
    request: {
      body: {
        content: { 'application/json': { schema: CreateApiKeySchema } },
      },
    },
    responses: {
      201: {
        description: 'Created',
        content: { 'application/json': { schema: ApiKeyCreatedSchema } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const body = c.req.valid('json');
    const db = getDb(c);

    // If a space scope was requested, resolve + verify it belongs to the active
    // org BEFORE minting the key (404 on missing/cross-tenant, no existence
    // leak). Org-wide keys (no space_id) skip this entirely.
    let spaceId: number | null = null;
    if (body.space_id) {
      const space = await getSpaceByUuid(db, body.space_id);
      if (!space || space.orgId !== c.var.activeOrgId) {
        throw new HTTPException(404, {
          message: `Space ${body.space_id} not found`,
        });
      }
      spaceId = space.id;
    }

    const { apiKey, rawKey } = await createApiKey(db, {
      userId: c.var.userId!,
      orgId: c.var.activeOrgId!,
      name: body.name,
      expiresAt: body.expires_at ? new Date(body.expires_at) : null,
      spaceId,
    });
    return c.json(
      {
        key_id: apiKey.uuid,
        name: apiKey.name,
        key_prefix: apiKey.keyPrefix,
        raw_key: rawKey,
        expires_at: apiKey.expiresAt?.toISOString() ?? null,
        space_id: body.space_id ?? null,
      },
      201,
    );
  },
);

authRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/keys',
    tags: ['auth'],
    summary: 'List API keys',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth] as const,
    request: { query: PaginationQuerySchema },
    responses: {
      200: {
        description: 'API keys',
        content: { 'application/json': { schema: ApiKeyListResponseSchema } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const db = getDb(c);
    const { limit, offset } = c.req.valid('query');
    const rows = await listApiKeysForUser(db, c.var.userId!, { limit, offset });
    return c.json(
      {
        keys: rows.map(({ apiKey: k, spaceUuid }) => ({
          key_id: k.uuid,
          name: k.name,
          key_prefix: k.keyPrefix,
          is_active: k.isActive,
          expires_at: k.expiresAt?.toISOString() ?? null,
          last_used_at: k.lastUsedAt?.toISOString() ?? null,
          created_at: k.createdAt.toISOString(),
          space_id: spaceUuid,
        })),
      },
      200,
    );
  },
);

authRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/keys/validate',
    tags: ['auth'],
    summary: 'Validate an API key',
    description:
      'Returns 200 if the key in the Authorization header is valid. Returns 401 otherwise.',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth] as const,
    responses: {
      200: {
        description: 'Key is valid',
        content: { 'application/json': { schema: ApiKeyValidateResponseSchema } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    if (c.var.authMethod !== 'api_key') {
      throw new HTTPException(401, { message: 'Not an API key' });
    }
    const db = getDb(c);
    const key = await getApiKeyByUuid(db, c.var.userId!, c.var.apiKeyUuid!);
    if (!key) throw new HTTPException(401, { message: 'Invalid API key' });
    return c.json({ valid: true, key_prefix: key.keyPrefix }, 200);
  },
);

authRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/keys/{key_uuid}',
    tags: ['auth'],
    summary: 'Revoke API key',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth] as const,
    request: {
      params: z.object({ key_uuid: z.string().uuid() }),
    },
    responses: {
      204: { description: 'Revoked' },
      ...errorResponses,
    },
  }),
  async (c) => {
    const { key_uuid } = c.req.valid('param');
    const db = getDb(c);
    const revoked = await revokeApiKey(db, c.var.userId!, key_uuid);
    if (!revoked) {
      throw new HTTPException(404, { message: 'API key not found' });
    }
    // Drop the KV cache entry so revocation takes effect immediately. Awaited
    // (not fire-and-forget) so the 204 only returns once we've attempted the
    // invalidation; on a KV error we log and still return success — the cache
    // TTL is the bounded backstop so a revoked key cannot linger indefinitely.
    try {
      await invalidateApiKeyCacheByHash(c.env, revoked.keyHash);
    } catch (err) {
      createLogger({ service: 'api', environment: c.env.ENVIRONMENT }).warn(
        'auth.api_key_cache_invalidation_failed',
        { stage: 'api_key_cache_invalidation' },
        err,
      );
    }
    return c.body(null, 204);
  },
);

// ---------------- /refresh + /logout ----------------

authRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/refresh',
    tags: ['auth'],
    summary: 'Exchange refresh token for new pair',
    middleware: [
      perIpRateLimit({ bucket: 'auth-refresh', tier: 'standard' }),
    ] as const,
    request: {
      body: {
        content: { 'application/json': { schema: RefreshRequestSchema } },
      },
    },
    responses: {
      200: {
        description: 'New token pair',
        content: { 'application/json': { schema: TokenPairSchema } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const { refresh_token, active_org_id } = c.req.valid('json');
    let claims;
    try {
      claims = await decodeRefreshTokenClaims(c.env.JWT_SECRET, refresh_token);
    } catch (err) {
      if (err instanceof InvalidTokenError) {
        throw new HTTPException(401, { message: err.message });
      }
      throw err;
    }

    const db = getDb(c);

    const user = await getUserById(db, claims.userId);
    if (!user) throw new HTTPException(401, { message: 'User not found' });
    if (!user.isActive) {
      throw new HTTPException(401, { message: 'User account inactive' });
    }

    // Rotate refresh token ATOMICALLY before minting the new pair. The
    // conditional revoke is a single race-free check-and-set: it succeeds only
    // if this jti was not already revoked. Two concurrent /refresh calls with
    // the same token therefore cannot both pass — exactly one wins, the other
    // observes the already-revoked row and is rejected as a reuse attempt
    // (prevents forking a token family into two live lineages).
    const rotated = await revokeRefreshTokenIfActive(db, {
      jti: claims.jti,
      userId: claims.userId,
      expiresAt: claims.expiresAt,
    });
    if (!rotated) {
      createLogger({
        service: 'api',
        environment: c.env.ENVIRONMENT,
        base: { user_id: claims.userId },
      }).warn('auth.refresh_reuse_detected', {
        reason: 'refresh_token_reuse',
        scope: 'auth',
      });
      throw new HTTPException(401, { message: 'Refresh token revoked' });
    }

    let membership = null;
    if (active_org_id) {
      const requestedOrgId = await resolveOrgIdFromUuid(db, active_org_id);
      if (requestedOrgId != null) {
        membership = await getMembership(db, requestedOrgId, user.id);
      }
    }
    membership ??= await getEarliestMembershipForUser(db, user.id);
    const activeOrgId = membership?.orgId ?? null;

    const pair = await createTokenPair(c.env.JWT_SECRET, user.id, {
      activeOrgId,
    });

    return c.json(
      {
        user_id: user.uuid,
        email: user.email,
        name: user.name,
        access_token: pair.accessToken,
        refresh_token: pair.refreshToken,
        token_type: 'bearer' as const,
        active_org_id: membership?.orgUuid ?? null,
      },
      200,
    );
  },
);

authRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/logout',
    tags: ['auth'],
    summary: 'Revoke refresh token (idempotent)',
    middleware: [
      perIpRateLimit({ bucket: 'auth-logout', tier: 'standard' }),
    ] as const,
    request: {
      body: {
        content: { 'application/json': { schema: LogoutRequestSchema } },
      },
    },
    responses: {
      204: { description: 'Logged out' },
    },
  }),
  async (c) => {
    const { refresh_token } = c.req.valid('json');
    try {
      const claims = await decodeRefreshTokenClaims(c.env.JWT_SECRET, refresh_token);
      const db = getDb(c);
      await revokeRefreshToken(db, {
        jti: claims.jti,
        userId: claims.userId,
        expiresAt: claims.expiresAt,
      });
    } catch (err) {
      // Idempotent: ignore invalid/expired tokens.
      if (!(err instanceof InvalidTokenError)) throw err;
    }

    // Also denylist the *access* token carried in the Authorization header so it
    // can't outlive the logout (its short TTL bounds the window even if this is
    // skipped, but explicit revocation makes logout take effect immediately).
    const authz = c.req.header('Authorization');
    if (authz?.startsWith('Bearer ')) {
      const token = authz.slice('Bearer '.length).trim();
      try {
        const access = await decodeAccessTokenClaims(c.env.JWT_SECRET, token);
        if (access.jti) {
          await revokeAccessToken(c.env, access.jti, access.expiresAt);
        }
      } catch (err) {
        // Not a valid access token (API key, expired, malformed) → nothing to
        // revoke. Logout stays idempotent.
        if (!(err instanceof InvalidTokenError)) throw err;
      }
    }
    return c.body(null, 204);
  },
);
