import {
  CreateSpaceSchema,
  QuotaExceededBodySchema,
  SpaceListResponseSchema,
  SpaceSchema,
  SpaceUsageQuerySchema,
  SpaceUsageResponseSchema,
} from './schemas';
import type { MemorySpace } from '@crosmos/db';
import { createRoute, z } from '@hono/zod-openapi';
import { createApiApp } from '../../lib/openapi';
import { createLogger } from '@crosmos/observability';
import { HTTPException } from 'hono/http-exception';
import { getDb } from '../../db';
import { getJobStore } from '../../integrations/job-store';
import { invalidateSpace } from '../../lib/gate-cache';
import { PaginationQuerySchema } from '../../lib/zod-common';
import { requireAuth } from '../auth/middleware';
import { requirePrincipal, requireRole } from '../auth/principal';
import { assertKeyScopeAllowsSpace } from '../../lib/key-scope';
import { getEntitlements } from '../orgs/entitlements';
import { getOrganizationByIdOrThrow } from '../orgs/service';
import { getSpaceUsage } from '../usage/service';
import {
  createSpaceAtomic,
  getSpaceByUuid,
  listSpaces,
  tombstoneSpace,
  SPACE_QUOTA_EXCEEDED,
} from './service';

export const spaceRoutes = createApiApp();

const ErrorBody = z.object({ detail: z.string() }).openapi('SpaceErrorBody');

/** Current calendar month [first day, last day] as `YYYY-MM-DD` (UTC). */
function defaultUsagePeriod(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

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
      query: z
        .object({
          name: z.string().min(1).optional(),
        })
        .merge(PaginationQuerySchema),
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
    const { name, limit, offset } = c.req.valid('query');
    const db = getDb(c);
    const orgId = c.var.activeOrgId!;

    const spaces = await listSpaces(db, { orgId, name: name ?? null, limit, offset });
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

// GET /api/v1/spaces/{space_uuid}/usage — per-space usage rollup
spaceRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/{space_uuid}/usage',
    tags: ['spaces'],
    summary: 'Get per-space usage',
    description:
      'Tokens ingested and search queries for a single space over a date range (defaults to the current calendar month). Use this to attribute usage to one end-user when you map one space per end-user.',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requirePrincipal] as const,
    request: {
      params: z.object({ space_uuid: z.string().uuid() }),
      query: SpaceUsageQuerySchema,
    },
    responses: {
      200: {
        description: 'Space usage for the selected period',
        content: { 'application/json': { schema: SpaceUsageResponseSchema } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const { space_uuid } = c.req.valid('param');
    const query = c.req.valid('query');
    const db = getDb(c);

    const space = await getSpaceByUuid(db, space_uuid);
    // 404 on both missing and cross-tenant (no existence leak).
    if (!space || space.orgId !== c.var.activeOrgId) {
      throw new HTTPException(404, { message: `Space ${space_uuid} not found` });
    }
    // A space-scoped API key can only read its own space's usage.
    assertKeyScopeAllowsSpace(c, space.id);

    const { start, end } = defaultUsagePeriod();
    const periodStart = query.start_date ?? start;
    const periodEnd = query.end_date ?? end;

    const usage = await getSpaceUsage(db, {
      orgId: space.orgId,
      spaceId: space.id,
      start: periodStart,
      end: periodEnd,
    });

    return c.json(
      {
        space_id: space.uuid,
        period_start: periodStart,
        period_end: periodEnd,
        tokens_ingested: usage.tokensIngested,
        search_queries: usage.searchQueries,
      },
      200,
    );
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

    const logger = createLogger({
      service: 'api',
      environment: c.env.ENVIRONMENT,
      base: { org_id: space.orgId, space_id: space.id },
    });

    // ── Deferred deletion ────────────────────────────────────────────────
    //
    // The tombstone goes FIRST, before cancelling jobs. Ordering matters: from
    // this instant every normal read path treats the space as absent and no new
    // work can enter it, so the cancel sweep below is closing a bounded set
    // rather than racing an open one. Doing it the other way round leaves a
    // window where a job is cancelled but a fresh one can still be created.
    //
    // Physical removal — cascading away sources, memories, entities, edges, and
    // purging their vectors — happens later in the maintenance sweep, once the
    // ingestion lease has lapsed and no jobs remain. Deleting immediately raced
    // in-flight workers and made a failed vector purge unrecoverable, because
    // the authoritative ids were already gone.
    const tombstoned = await tombstoneSpace(db, {
      orgId: space.orgId,
      spaceId: space.id,
    });

    // Cancel regardless of whether WE set the tombstone: a repeated delete must
    // still converge, and a job could have been created between a previous
    // tombstone and now.
    await getJobStore(db).cancelJobsForSpace(space.id);

    logger.info('spaces.deleted', {
      // false ⇒ already tombstoned by an earlier call. Still a 204: the space is
      // gone from the caller's point of view, which was already true.
      deterministic: tombstoned,
      reason: tombstoned ? 'tombstoned' : 'already_tombstoned',
    });

    // Drop the cached gate entry — reads must stop resolving this space NOW,
    // not when the (up to) TTL-long cache entry happens to expire. This is the
    // one step whose failure would leave the space briefly reachable, so it is
    // awaited rather than deferred.
    try {
      await invalidateSpace(c.env, space_uuid);
    } catch (err) {
      logger.warn('gate_cache.space_invalidation_failed', {
        stage: 'gate_cache_invalidation',
      }, err);
    }

    return c.body(null, 204);
  },
);
