import {
  CreateSpaceSchema,
  QuotaExceededBodySchema,
  SpaceListResponseSchema,
  SpaceSchema,
} from './schemas';
import type { MemorySpace } from '@crosmos/db';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { createLogger } from '@crosmos/observability';
import { HTTPException } from 'hono/http-exception';
import type { HonoEnv } from '../../bindings';
import { getDb } from '../../db';
import { getJobStore } from '../../integrations/job-store';
import { invalidateSpace } from '../../lib/gate-cache';
import { waitUntilLogged } from '../../lib/runtime';
import { requireAuth } from '../auth/middleware';
import { requirePrincipal, requireRole } from '../auth/principal';
import { checkCountQuota, QuotaExceededError } from '../orgs/entitlements';
import { getOrganizationByIdOrThrow } from '../orgs/service';
import {
  countSpaces,
  createSpace,
  deleteSpace,
  getSpaceByUuid,
  listSpaces,
} from './service';

export const spaceRoutes = new OpenAPIHono<HonoEnv>();

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

    const existingCount = await countSpaces(db, orgId);
    try {
      await checkCountQuota(db, orgId, 'max_memory_spaces', existingCount);
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        return c.json(
          {
            detail: {
              error: 'quota_exceeded' as const,
              key: err.key,
              limit: err.limit,
              used: err.used,
            },
          },
          429,
        );
      }
      throw err;
    }

    const space = await createSpace(db, {
      userId: c.var.userId!,
      orgId,
      name: body.name,
      description: body.description ?? null,
      meta: body.meta ?? null,
    });
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

    const deleted = await deleteSpace(db, { orgId: space.orgId, spaceId: space.id });
    if (!deleted) {
      throw new HTTPException(404, { message: `Space ${space_uuid} not found` });
    }
    // Drop the cached gate entry — this space no longer exists.
    waitUntilLogged(
      c,
      createLogger({
        service: 'api',
        environment: c.env.ENVIRONMENT,
        base: {
          org_id: space.orgId,
          space_id: space.id,
        },
      }),
      'gate_cache.space_invalidation_failed',
      invalidateSpace(c.env, space_uuid),
      { stage: 'gate_cache_invalidation' },
    );
    return c.body(null, 204);
  },
);
