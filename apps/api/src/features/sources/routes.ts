import { memorySpaces, sources, type Source } from '@crosmos/db';
import { createLogger, durationMs } from '@crosmos/observability';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import type { HonoEnv } from '../../bindings';
import { getDb } from '../../db';
import { getJobStore } from '../../integrations/job-store';
import { getQueueService } from '../../integrations/queue';
import { getRateLimiter } from '../../integrations/rate-limit';
import { waitUntilLogged } from '../../lib/runtime';
import type { TenantScope } from '../../lib/scope';
import { UuidSchema } from '../../lib/zod-common';
import { requireAuth } from '../auth/middleware';
import { requirePrincipal } from '../auth/principal';
import { preflight } from './gates';
import {
  IngestAcceptedResponseSchema,
  IngestSourcesRequestSchema,
  ListSourcesQuerySchema,
  QuotaExceededBodySchema,
  RateLimitedBodySchema,
  SourceListResponseSchema,
  SourceResponseSchema,
  SourceScopedQuerySchema,
  SourceVisibilityResponseSchema,
  UpdateSourceVisibilityRequestSchema,
} from './schemas';
import {
  countSourcesByOrg,
  createSources,
  deleteSource,
  listSourcesByOrg,
  setSourceVisibility,
  type ContentType,
} from './service';
import { resolveReadVisibility } from '../visibility/service';

export const sourceRoutes = new OpenAPIHono<HonoEnv>();

const ErrorBody = z.object({ detail: z.string() }).openapi('SourceErrorBody');

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

function toResponse(source: Source, spaceUuid: string) {
  return {
    id: source.uuid,
    space_id: spaceUuid,
    content: source.content,
    content_type: source.contentType,
    extraction_status: source.extractionStatus,
    meta: (source.meta as Record<string, unknown> | null) ?? null,
    token_count: source.tokenCount,
    created_at: source.createdAt.toISOString(),
    updated_at: source.updatedAt.toISOString(),
  };
}

function toSummary(source: Source, spaceUuid: string) {
  return {
    id: source.uuid,
    space_id: spaceUuid,
    content_type: source.contentType,
    extraction_status: source.extractionStatus,
    meta: (source.meta as Record<string, unknown> | null) ?? null,
    token_count: source.tokenCount,
    created_at: source.createdAt.toISOString(),
    updated_at: source.updatedAt.toISOString(),
    content_preview: source.content.slice(0, 200),
  };
}

// POST /api/v1/sources — async ingestion (returns 202 + job_id)
sourceRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['sources'],
    summary: 'Ingest Sources',
    description:
      'Enqueue a batch of sources for asynchronous ingestion. Fire-and-forget: returns 202 with a job_id you can poll via GET /jobs/{job_id}.',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requirePrincipal] as const,
    request: {
      body: {
        content: { 'application/json': { schema: IngestSourcesRequestSchema } },
      },
    },
    responses: {
      202: {
        description: 'Accepted — job enqueued',
        content: { 'application/json': { schema: IngestAcceptedResponseSchema } },
      },
      429: {
        description: 'Rate limited / quota / pending cap',
        content: {
          'application/json': {
            schema: z.union([
              RateLimitedBodySchema,
              QuotaExceededBodySchema,
              ErrorBody,
            ]),
          },
        },
      },
      503: {
        description: 'Queue full',
        content: { 'application/json': { schema: ErrorBody } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const body = c.req.valid('json');
    const db = getDb(c);
    const orgId = c.var.activeOrgId!;
    const userId = c.var.userId!;
    const requestId = c.var.requestId ?? crypto.randomUUID();
    const logger = createLogger({
      service: 'api',
      environment: c.env.ENVIRONMENT,
      base: {
        request_id: requestId,
        org_id: orgId,
        user_id: userId,
      },
    });
    const enqueueStart = performance.now();
    logger.info('ingestion.enqueue_started', {
      source_count: body.sources.length,
    });

    const limiter = getRateLimiter(c.env);
    const queue = getQueueService(c.env, db);
    const jobStore = getJobStore(db);

    const preflightStart = performance.now();
    const space = await preflight({
      db,
      limiter,
      queue,
      jobStore,
      orgId,
      userId,
      spaceUuid: body.space_id,
    });
    logger.info('ingestion.enqueue_stage_completed', {
      stage: 'preflight',
      space_id: space.id,
      duration_ms: durationMs(preflightStart),
    });

    const scope: TenantScope = {
      orgId: space.orgId,
      spaceId: space.id,
      userId,
    };

    // Stitch role onto meta (Python merges payload.role into meta.role).
    const inserts = body.sources.map((payload, i) => {
      const meta: Record<string, unknown> = {
        ...((payload.meta as Record<string, unknown> | null) ?? {}),
      };
      if (payload.role) meta.role = payload.role;
      return {
        scope,
        content: payload.content,
        contentType: payload.content_type as ContentType,
        visibility: payload.visibility,
        meta: Object.keys(meta).length > 0 ? meta : null,
      };
    });
    const created = await logger.time('ingestion.enqueue_stage_completed', {
      stage: 'source_insert',
      space_id: space.id,
      source_count: inserts.length,
      error_category: 'internal',
      dependency: 'database',
    }, () => createSources(db, inserts));

    const jobId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    await logger.time('ingestion.enqueue_stage_completed', {
      stage: 'job_create',
      space_id: space.id,
      error_category: 'internal',
      dependency: 'database',
    }, () => jobStore.create({
      jobId,
      orgId: space.orgId,
      spaceId: space.id,
      userId,
      sourceIds: created.map((s) => s.id),
    }));

    const enqueuedAtMs = Date.now();
    const jobMessage = {
      task: 'process_ingestion' as const,
      job_id: jobId,
      correlation_id: correlationId,
      org_id: space.orgId,
      space_id: space.id,
      user_id: userId,
      source_ids: created.map((s) => s.id),
      enqueued_at_ms: enqueuedAtMs,
    };
    // Durable enqueue first (the backstop), then the low-latency direct kick.
    await logger.time('ingestion.enqueue_stage_completed', {
      stage: 'queue_enqueue',
      space_id: space.id,
      error_category: 'external_service',
      dependency: 'queue',
    }, () => queue.enqueue(jobMessage));
    // Best-effort: start ingestion now over the service binding so we don't eat
    // the queue's cold-delivery latency. Off the response path; the enqueued
    // copy still runs the job if this fails.
    waitUntilLogged(
      c,
      logger,
      'ingestion.kick_failed',
      queue.kick(jobMessage),
      { space_id: space.id, job_id: jobId },
    );
    logger.info('ingestion.enqueue_accepted', {
      space_id: space.id,
      source_count: created.length,
      duration_ms: durationMs(enqueueStart),
    });

    return c.json(
      {
        job_id: jobId,
        status: 'pending' as const,
        source_ids: created.map((s) => s.uuid),
      },
      202,
    );
  },
);

// GET /api/v1/sources — list (across all spaces in org, or one space)
sourceRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['sources'],
    summary: 'List Sources',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requirePrincipal] as const,
    request: { query: ListSourcesQuerySchema },
    responses: {
      200: {
        description: 'Sources',
        content: { 'application/json': { schema: SourceListResponseSchema } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const query = c.req.valid('query');
    const db = getDb(c);
    const orgId = c.var.activeOrgId!;
    const visibleUserIds = await resolveReadVisibility(db, {
      orgId,
      userId: c.var.userId!,
    });

    // If `?space_id=` is given, verify access first so cross-tenant lookups
    // surface as 404 before any data is selected.
    let resolvedSpaceId: number | undefined;
    if (query.space_id) {
      const [space] = await db
        .select({ id: memorySpaces.id, orgId: memorySpaces.orgId })
        .from(memorySpaces)
        .where(eq(memorySpaces.uuid, query.space_id))
        .limit(1);
      if (!space || space.orgId !== orgId) {
        throw new HTTPException(404, {
          message: `Space ${query.space_id} not found`,
        });
      }
      resolvedSpaceId = space.id;
    }

    const filters = {
      orgId,
      spaceId: resolvedSpaceId,
      contentType: query.content_type,
      extractionStatus: query.extraction_status,
      visibleUserIds,
    };

    const [results, total] = await Promise.all([
      listSourcesByOrg(db, {
        ...filters,
        limit: query.limit,
        offset: query.offset,
      }),
      countSourcesByOrg(db, filters),
    ]);

    return c.json(
      {
        sources: results.map((r) => toSummary(r.source, r.spaceUuid)),
        count: results.length,
        total,
      },
      200,
    );
  },
);

// DELETE /api/v1/sources/{source_uuid}
sourceRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/{source_uuid}',
    tags: ['sources'],
    summary: 'Delete Source',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requirePrincipal] as const,
    request: {
      params: z.object({ source_uuid: UuidSchema }),
      query: SourceScopedQuerySchema,
    },
    responses: {
      204: { description: 'Deleted' },
      ...errorResponses,
    },
  }),
  async (c) => {
    const { source_uuid } = c.req.valid('param');
    const { space_id } = c.req.valid('query');
    const db = getDb(c);
    const orgId = c.var.activeOrgId!;
    const userId = c.var.userId!;
    const spaceId = await resolveSpaceIdForCaller(c, space_id);

    const visibleUserIds = await resolveReadVisibility(db, { orgId, userId });
    const source = await loadSourceForCaller(
      db,
      source_uuid,
      orgId,
      visibleUserIds,
      spaceId,
    );
    const scope: TenantScope = {
      orgId: source.orgId,
      spaceId: source.spaceId,
      userId,
    };
    const deleted = await deleteSource(db, scope, source.id);
    if (!deleted) {
      throw new HTTPException(404, {
        message: `Source ${source_uuid} not found`,
      });
    }
    return c.body(null, 204);
  },
);

// GET /api/v1/sources/{source_uuid}
sourceRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/{source_uuid}',
    tags: ['sources'],
    summary: 'Get Source',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requirePrincipal] as const,
    request: {
      params: z.object({ source_uuid: UuidSchema }),
      query: SourceScopedQuerySchema,
    },
    responses: {
      200: {
        description: 'Source',
        content: { 'application/json': { schema: SourceResponseSchema } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const { source_uuid } = c.req.valid('param');
    const { space_id } = c.req.valid('query');
    const db = getDb(c);
    const orgId = c.var.activeOrgId!;
    const spaceId = await resolveSpaceIdForCaller(c, space_id);

    const visibleUserIds = await resolveReadVisibility(db, {
      orgId,
      userId: c.var.userId!,
    });
    const source = await loadSourceForCaller(
      db,
      source_uuid,
      orgId,
      visibleUserIds,
      spaceId,
    );
    const [spaceRow] = await db
      .select({ uuid: memorySpaces.uuid })
      .from(memorySpaces)
      .where(eq(memorySpaces.id, source.spaceId))
      .limit(1);
    if (!spaceRow) {
      // Should be unreachable: FK CASCADE means a source can't outlive its space.
      throw new HTTPException(404, {
        message: `Source ${source_uuid} not found`,
      });
    }
    return c.json(toResponse(source, spaceRow.uuid), 200);
  },
);

// PATCH /api/v1/sources/{source_uuid}/visibility
sourceRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/{source_uuid}/visibility',
    tags: ['sources'],
    summary: 'Update Source Visibility',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requirePrincipal] as const,
    request: {
      params: z.object({ source_uuid: UuidSchema }),
      query: SourceScopedQuerySchema,
      body: {
        content: {
          'application/json': {
            schema: UpdateSourceVisibilityRequestSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Updated visibility',
        content: { 'application/json': { schema: SourceVisibilityResponseSchema } },
      },
      403: {
        description: 'Forbidden',
        content: { 'application/json': { schema: ErrorBody } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const { source_uuid } = c.req.valid('param');
    const { space_id } = c.req.valid('query');
    const { visibility } = c.req.valid('json');
    const db = getDb(c);
    const orgId = c.var.activeOrgId!;
    const spaceId = await resolveSpaceIdForCaller(c, space_id);

    const source = await loadSourceForCaller(db, source_uuid, orgId, null, spaceId);
    if (source.ownerUserId !== c.var.userId && !['owner', 'admin'].includes(c.var.orgRole ?? '')) {
      throw new HTTPException(403, {
        message: 'Only the source owner or an org owner/admin can change its visibility.',
      });
    }

    const result = await setSourceVisibility(
      db,
      { orgId: source.orgId, spaceId: source.spaceId, userId: c.var.userId! },
      source.id,
      visibility,
    );
    return c.json(
      {
        id: source.uuid,
        visibility,
        memories_updated: result.memoriesUpdated,
        edges_updated: result.edgesUpdated,
      },
      200,
    );
  },
);

/**
 * Look up a source by uuid and confirm it belongs to the caller's org. 404
 * on both missing and cross-tenant (no existence leak — Python behavior).
 */
async function loadSourceForCaller(
  db: ReturnType<typeof getDb>,
  sourceUuid: string,
  orgId: number,
  visibleUserIds: readonly number[] | null,
  spaceId?: number,
): Promise<Source> {
  const conditions = [eq(sources.uuid, sourceUuid), eq(sources.orgId, orgId)];
  if (spaceId !== undefined) {
    conditions.push(eq(sources.spaceId, spaceId));
  }
  if (visibleUserIds != null) {
    conditions.push(
      visibleUserIds.length === 0
        ? sql`false`
        : or(
            eq(sources.visibility, 'org'),
            inArray(sources.ownerUserId, [...visibleUserIds]),
          )!,
    );
  }
  const [row] = await db
    .select()
    .from(sources)
    .where(and(...conditions))
    .limit(1);
  if (!row) {
    throw new HTTPException(404, {
      message: `Source ${sourceUuid} not found`,
    });
  }
  return row;
}

async function resolveSpaceIdForCaller(
  c: Parameters<typeof getDb>[0],
  spaceUuid: string,
): Promise<number> {
  const [space] = await getDb(c)
    .select({ id: memorySpaces.id, orgId: memorySpaces.orgId })
    .from(memorySpaces)
    .where(eq(memorySpaces.uuid, spaceUuid))
    .limit(1);
  if (!space || space.orgId !== c.var.activeOrgId) {
    throw new HTTPException(404, { message: 'Space not found' });
  }
  return space.id;
}
