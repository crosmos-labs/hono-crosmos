import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { createLogger, durationMs } from '@crosmos/observability';
import type { HonoEnv } from '../../bindings';
import { getDb } from '../../db';
import { getJobStore } from '../../integrations/job-store';
import { getQueueService } from '../../integrations/queue';
import { getRateLimiter } from '../../integrations/rate-limit';
import type { TenantScope } from '../../lib/scope';
import { requireAuth } from '../auth/middleware';
import { requirePrincipal } from '../auth/principal';
import { preflight } from '../sources/gates';
import {
  QuotaExceededBodySchema,
  RateLimitedBodySchema,
} from '../sources/schemas';
import { createSources } from '../sources/service';
import {
  IngestConversationRequestSchema,
  IngestConversationResponseSchema,
} from './schemas';
import { buildContext, formatMessages, segmentMessages } from './sessions';

export const conversationRoutes = new OpenAPIHono<HonoEnv>();

const ErrorBody = z
  .object({ detail: z.string() })
  .openapi('ConversationErrorBody');

// POST /api/v1/conversations — multi-turn ingestion
conversationRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['conversations'],
    summary: 'Ingest Conversation',
    description:
      'Ingest a multi-turn conversation. Messages are segmented into batches of 4; each segment becomes one source with the prior 4 segments attached as `meta.lookback_context` for pronoun resolution during extraction.',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requirePrincipal] as const,
    request: {
      body: {
        content: {
          'application/json': { schema: IngestConversationRequestSchema },
        },
      },
    },
    responses: {
      202: {
        description: 'Accepted — job enqueued',
        content: {
          'application/json': { schema: IngestConversationResponseSchema },
        },
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
      source_count: Math.ceil(body.messages.length / 4),
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

    const sessionId = body.session_id ?? crypto.randomUUID();
    const segments = segmentMessages(body.messages);

    const inserts = segments.map((segment, i) => {
      const meta: Record<string, unknown> = { session_id: sessionId };
      if (body.session_date) meta.date = body.session_date;
      if (body.meta) Object.assign(meta, body.meta);
      const context = buildContext(segments, i);
      if (context) meta.lookback_context = context;
      return {
        scope,
        content: formatMessages(segment),
        contentType: 'text' as const,
        sequence: i,
        meta,
      };
    });
    const sourceInsertStart = performance.now();
    const created = await createSources(db, inserts);
    logger.info('ingestion.enqueue_stage_completed', {
      stage: 'source_insert',
      space_id: space.id,
      source_count: created.length,
      duration_ms: durationMs(sourceInsertStart),
    });

    const jobId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const jobCreateStart = performance.now();
    await jobStore.create({
      jobId,
      orgId: space.orgId,
      spaceId: space.id,
      userId,
      sourceIds: created.map((s) => s.id),
    });
    logger.info('ingestion.enqueue_stage_completed', {
      stage: 'job_create',
      space_id: space.id,
      duration_ms: durationMs(jobCreateStart),
    });

    const enqueuedAtMs = Date.now();
    await logger.time('ingestion.enqueue_stage_completed', {
      stage: 'queue_enqueue',
      space_id: space.id,
    }, () => queue.enqueue({
      task: 'process_ingestion',
      job_id: jobId,
      correlation_id: correlationId,
      org_id: space.orgId,
      space_id: space.id,
      user_id: userId,
      source_ids: created.map((s) => s.id),
      enqueued_at_ms: enqueuedAtMs,
    }));
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
