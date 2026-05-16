import { memorySpaces, sources, type Source } from '@crosmos/db';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import type { HonoEnv } from '../../bindings';
import { getDb } from '../../db';
import { getJobStore } from '../../integrations/job-store';
import { getQueueService } from '../../integrations/queue';
import { getRateLimiter } from '../../integrations/rate-limit';
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
} from './schemas';
import {
  countSourcesByOrg,
  createSources,
  deleteSource,
  listSourcesByOrg,
  type ContentType,
} from './service';

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
    sequence: source.sequence,
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
    sequence: source.sequence,
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

    const limiter = getRateLimiter(c.env);
    const queue = getQueueService(c.env, db);
    const jobStore = getJobStore(db);

    const space = await preflight({
      db,
      limiter,
      queue,
      jobStore,
      orgId,
      userId,
      spaceUuid: body.space_id,
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
        sequence: payload.sequence ?? i,
        meta: Object.keys(meta).length > 0 ? meta : null,
      };
    });
    const created = await createSources(db, inserts);

    const jobId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    await jobStore.create({
      jobId,
      orgId: space.orgId,
      spaceId: space.id,
      userId,
      sourceIds: created.map((s) => s.id),
    });
    await queue.enqueue({
      task: 'process_ingestion',
      job_id: jobId,
      correlation_id: correlationId,
      org_id: space.orgId,
      space_id: space.id,
      user_id: userId,
      source_ids: created.map((s) => s.id),
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
    request: { params: z.object({ source_uuid: UuidSchema }) },
    responses: {
      204: { description: 'Deleted' },
      ...errorResponses,
    },
  }),
  async (c) => {
    const { source_uuid } = c.req.valid('param');
    const db = getDb(c);
    const orgId = c.var.activeOrgId!;
    const userId = c.var.userId!;

    const source = await loadSourceForCaller(db, source_uuid, orgId);
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
    request: { params: z.object({ source_uuid: UuidSchema }) },
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
    const db = getDb(c);
    const orgId = c.var.activeOrgId!;

    const source = await loadSourceForCaller(db, source_uuid, orgId);
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

/**
 * Look up a source by uuid and confirm it belongs to the caller's org. 404
 * on both missing and cross-tenant (no existence leak — Python behavior).
 */
async function loadSourceForCaller(
  db: ReturnType<typeof getDb>,
  sourceUuid: string,
  orgId: number,
): Promise<Source> {
  const [row] = await db
    .select()
    .from(sources)
    .where(eq(sources.uuid, sourceUuid))
    .limit(1);
  if (!row || row.orgId !== orgId) {
    throw new HTTPException(404, {
      message: `Source ${sourceUuid} not found`,
    });
  }
  return row;
}
