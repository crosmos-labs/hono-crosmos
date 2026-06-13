import {
  CreateSpaceSchema,
  QuotaExceededBodySchema,
  SpaceListResponseSchema,
  SpaceSchema,
} from './schemas';
import type { MemorySpace } from '@crosmos/db';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { createApiApp } from '../../lib/openapi';
import { createLogger } from '@crosmos/observability';
import { HTTPException } from 'hono/http-exception';
import type { HonoEnv } from '../../bindings';
import { getDb } from '../../db';
import { getJobStore } from '../../integrations/job-store';
import { getVectorStore, type VectorStore } from '../../integrations/vector-store';
import { invalidateSpace } from '../../lib/gate-cache';
import { waitUntilLogged } from '../../lib/runtime';
import { requireAuth } from '../auth/middleware';
import { requirePrincipal, requireRole } from '../auth/principal';
import { getEntitlements } from '../orgs/entitlements';
import { getOrganizationByIdOrThrow } from '../orgs/service';
import {
  createSpaceAtomic,
  deleteSpace,
  getSpaceByUuid,
  listSpaces,
  SPACE_QUOTA_EXCEEDED,
} from './service';

export const spaceRoutes = createApiApp();

const ErrorBody = z.object({ detail: z.string() }).openapi('SpaceErrorBody');

const errorResponses = {
  400: {
    description: 'Bad request',
    content: { 'application/json': { schema: ErrorBody } },
  },
  401: {
    description: 'Unauthorized',
    content: { 'application/json': { schema: ErrorBody } },
  },
  404: {
    description: 'Not found',
    content: { 'application/json': { schema: ErrorBody } },
  },
};

async function toResponse(
  c: any,
  space: MemorySpace,
): Promise<{
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}> {
  const db = getDb(c);
  const org = await getOrganizationByIdOrThrow(db, space.orgId);
  return {
    id: space.uuid,
    org_id: org.uuid,
    name: space.name,
    description: space.description,
    meta: (space.meta as Record<string, unknown> | null) ?? null,
    created_at: space.createdAt.toISOString(),
    updated_at: space.updatedAt.toISOString(),
  };
}

// POST /api/v1/spaces — any role can create
spaceRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['spaces'],
    summary: 'Create memory space',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requireRole('owner', 'admin', 'member')] as const,
    request: {
      body: { content: { 'application/json': { schema: CreateSpaceSchema } } },
    },
    responses: {
      201: {
        description: 'Created',
        content: { 'application/json': { schema: SpaceSchema } },
      },
      429: {
        description: 'Quota exceeded',
        content: { 'application/json': { schema: QuotaExceededBodySchema } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const body = c.req.valid('json');
    const db = getDb(c);
    const orgId = c.var.activeOrgId!;

    // Resolve the plan cap, then enforce it ATOMICALLY inside the insert (a
    // count-then-create was a TOCTOU race: concurrent creates all read the same
    // pre-insert count and overran the cap). `createSpaceAtomic` counts + inserts
    // under an org row lock and returns the sentinel when at/over the cap.
    const ent = await getEntitlements(db, orgId);
    const rawLimit = ent.max_memory_spaces;
    const limit = typeof rawLimit === 'number' ? rawLimit : -1;

    const space = await createSpaceAtomic(db, {
      userId: c.var.userId!,
      orgId,
      name: body.name,
      description: body.description ?? null,
      meta: body.meta ?? null,
      limit,
    });
    if (space === SPACE_QUOTA_EXCEEDED) {
      // Structured quota body (schema-backed `QuotaExceededBodySchema`), kept
      // consistent with the sibling source/conversation quota responses.
      // `used === limit` since the cap is enforced at the boundary.
      return c.json(
        {
          detail: {
            error: 'quota_exceeded' as const,
            key: 'max_memory_spaces',
            limit,
            used: limit,
          },
        },
        429,
      );
    }
    return c.json(await toResponse(c, space), 201);
  },
);

// GET /api/v1/spaces — list (with optional ?name= exact filter)
spaceRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['spaces'],
    summary: 'List memory spaces in active org',
    description:
      'Pass ?name= to resolve a space by its name (returns 0 or 1 since names are unique per org).',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requirePrincipal] as const,
    request: {
      query: z.object({
        name: z.string().min(1).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Spaces',
        content: { 'application/json': { schema: SpaceListResponseSchema } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const { name } = c.req.valid('query');
    const db = getDb(c);
    const orgId = c.var.activeOrgId!;

    const spaces = await listSpaces(db, { orgId, name: name ?? null });
    const out = await Promise.all(spaces.map((s) => toResponse(c, s)));
    return c.json({ spaces: out, total: out.length }, 200);
  },
);

// GET /api/v1/spaces/{space_uuid}
spaceRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/{space_uuid}',
    tags: ['spaces'],
    summary: 'Get memory space',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requirePrincipal] as const,
    request: {
      params: z.object({ space_uuid: z.string().uuid() }),
    },
    responses: {
      200: {
        description: 'Space',
        content: { 'application/json': { schema: SpaceSchema } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const { space_uuid } = c.req.valid('param');
    const db = getDb(c);

    const space = await getSpaceByUuid(db, space_uuid);
    // 404 on both missing and cross-tenant (mirrors verify_space_access_by_uuid).
    if (!space || space.orgId !== c.var.activeOrgId) {
      throw new HTTPException(404, { message: `Space ${space_uuid} not found` });
    }
    return c.json(await toResponse(c, space), 200);
  },
);

// DELETE /api/v1/spaces/{space_uuid} — owner/admin only
spaceRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/{space_uuid}',
    tags: ['spaces'],
    summary: 'Delete memory space (owner/admin only)',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requireRole('owner', 'admin')] as const,
    request: {
      params: z.object({ space_uuid: z.string().uuid() }),
    },
    responses: {
      204: { description: 'Deleted' },
      403: {
        description: 'Insufficient role',
        content: { 'application/json': { schema: ErrorBody } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const { space_uuid } = c.req.valid('param');
    const db = getDb(c);

    const space = await getSpaceByUuid(db, space_uuid);
    if (!space || space.orgId !== c.var.activeOrgId) {
      throw new HTTPException(404, { message: `Space ${space_uuid} not found` });
    }

    await getJobStore(db).cancelJobsForSpace(space.id);

    const { deleted, memoryIds, entityIds } = await deleteSpace(db, {
      orgId: space.orgId,
      spaceId: space.id,
    });
    if (!deleted) {
      throw new HTTPException(404, { message: `Space ${space_uuid} not found` });
    }

    const logger = createLogger({
      service: 'api',
      environment: c.env.ENVIRONMENT,
      base: {
        org_id: space.orgId,
        space_id: space.id,
      },
    });

    // Drop the cached gate entry — this space no longer exists.
    waitUntilLogged(
      c,
      logger,
      'gate_cache.space_invalidation_failed',
      invalidateSpace(c.env, space_uuid),
      { stage: 'gate_cache_invalidation' },
    );

    // The DB cascade removed all of the space's memories + entities, but cannot
    // reach the external vector index (Vectorize). Purge their vectors best-
    // effort, off the response path, in bounded chunks. No-op when vectors live
    // in the pg column (the cascade already removed them).
    const vectorStore = getVectorStore(c.env, db);
    if (!vectorStore.persistsInColumn) {
      logger.info('spaces.vector_purge_scheduled', {
        deleted_count: memoryIds.length + entityIds.length,
        vector_count: memoryIds.length + entityIds.length,
      });
      if (memoryIds.length > 0) {
        waitUntilLogged(
          c,
          logger,
          'spaces.vector_purge_failed',
          deleteVectorsChunked(vectorStore, 'memories', memoryIds),
          { scope: 'memories', vector_count: memoryIds.length },
        );
      }
      if (entityIds.length > 0) {
        waitUntilLogged(
          c,
          logger,
          'spaces.vector_purge_failed',
          deleteVectorsChunked(vectorStore, 'entities', entityIds),
          { scope: 'entities', vector_count: entityIds.length },
        );
      }
    }
    return c.body(null, 204);
  },
);

/** Max vector ids per `deleteByIds` call (bounds the upstream request size). */
const VECTOR_DELETE_CHUNK = 1000;

/**
 * Purge vectors from the external store in bounded chunks so a large space
 * delete doesn't issue one unbounded request. Best-effort: the caller wraps this
 * in `waitUntilLogged`, so a rejection is logged rather than failing the request.
 */
async function deleteVectorsChunked(
  vectorStore: VectorStore,
  collection: 'memories' | 'entities',
  ids: number[],
): Promise<void> {
  for (let i = 0; i < ids.length; i += VECTOR_DELETE_CHUNK) {
    await vectorStore.deleteByIds(collection, ids.slice(i, i + VECTOR_DELETE_CHUNK));
  }
}
