import { createTokenPair, decodeRefreshTokenClaims, InvalidTokenError } from './jwt';
import {
  ApiKeyCreatedSchema,
  ApiKeyListResponseSchema,
  ApiKeyValidateResponseSchema,
  CreateApiKeySchema,
  LogoutRequestSchema,
  RefreshRequestSchema,
  TokenPairSchema,
  UpdateUserSchema,
  UserSchema,
} from './schemas';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { createLogger } from '@crosmos/observability';
import { HTTPException } from 'hono/http-exception';
import type { HonoEnv } from '../../bindings';
import { getDb } from '../../db';
import { waitUntilLogged } from '../../lib/runtime';
import { invalidateApiKeyCacheByHash, requireAuth, requireOrg } from './middleware';
import {
  createApiKey,
  getApiKeyByUuid,
  listApiKeysForUser,
  revokeApiKey,
} from './api-keys';
import { getEarliestMembershipForUser } from '../orgs/memberships';
import {
  isRefreshTokenRevoked,
  revokeRefreshToken,
} from './refresh-tokens';
import { getUserById, updateUserName } from './users';

export const authRoutes = new OpenAPIHono<HonoEnv>();

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
    middleware: [requireAuth] as const,
    responses: {
      200: {
        description: 'Current user',
        content: { 'application/json': { schema: UserSchema } },
      },
      ...errorResponses,
    },
  }),
  (c) => {
    return c.json(
      {
        id: c.var.userUuid!,
        email: c.var.userEmail!,
        name: c.var.userName!,
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
    middleware: [requireAuth] as const,
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
      return c.json(
        { id: updated.uuid, email: updated.email, name: updated.name },
        200,
      );
    }
    const user = await getUserById(db, c.var.userId!);
    if (!user) throw new HTTPException(404, { message: 'User not found' });
    return c.json({ id: user.uuid, email: user.email, name: user.name }, 200);
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
    middleware: [requireAuth, requireOrg] as const,
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
    const { apiKey, rawKey } = await createApiKey(db, {
      userId: c.var.userId!,
      orgId: c.var.activeOrgId!,
      name: body.name,
      expiresAt: body.expires_at ? new Date(body.expires_at) : null,
    });
    return c.json(
      {
        key_id: apiKey.uuid,
        name: apiKey.name,
        key_prefix: apiKey.keyPrefix,
        raw_key: rawKey,
        expires_at: apiKey.expiresAt?.toISOString() ?? null,
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
    const rows = await listApiKeysForUser(db, c.var.userId!);
    return c.json(
      {
        keys: rows.map((k) => ({
          key_id: k.uuid,
          name: k.name,
          key_prefix: k.keyPrefix,
          is_active: k.isActive,
          expires_at: k.expiresAt?.toISOString() ?? null,
          last_used_at: k.lastUsedAt?.toISOString() ?? null,
          created_at: k.createdAt.toISOString(),
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
    // Best-effort: drop KV cache entry so revocation takes effect immediately.
    waitUntilLogged(
      c,
      createLogger({ service: 'api', environment: c.env.ENVIRONMENT }),
      'auth.api_key_cache_invalidation_failed',
      invalidateApiKeyCacheByHash(c.env, revoked.keyHash),
      { stage: 'api_key_cache_invalidation' },
    );
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
    const { refresh_token } = c.req.valid('json');
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

    if (await isRefreshTokenRevoked(db, claims.jti)) {
      throw new HTTPException(401, { message: 'Refresh token revoked' });
    }

    const user = await getUserById(db, claims.userId);
    if (!user) throw new HTTPException(401, { message: 'User not found' });
    if (!user.isActive) {
      throw new HTTPException(401, { message: 'User account inactive' });
    }

    // Rotate refresh token: revoke the one we just used.
    waitUntilLogged(
      c,
      createLogger({
        service: 'api',
        environment: c.env.ENVIRONMENT,
        base: {
          user_id: claims.userId,
        },
      }),
      'auth.refresh_revoke_failed',
      revokeRefreshToken(db, {
        jti: claims.jti,
        userId: claims.userId,
        expiresAt: claims.expiresAt,
      }),
      { stage: 'refresh_revoke' },
    );

    const membership = await getEarliestMembershipForUser(db, user.id);
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
    return c.body(null, 204);
  },
);
