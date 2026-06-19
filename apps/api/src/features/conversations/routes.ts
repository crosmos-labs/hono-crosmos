import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { createApiApp } from '../../lib/openapi';
import { createLogger, durationMs } from '@crosmos/observability';
import type { HonoEnv } from '../../bindings';
import { getDb } from '../../db';
import { getJobStore } from '../../integrations/job-store';
import { getQueueService } from '../../integrations/queue';
import { getRateLimiter } from '../../integrations/rate-limit';
import { getOperationalLimits } from '../../lib/limits';
import type { TenantScope } from '../../lib/scope';
import { requireAuth } from '../auth/middleware';
import { requirePrincipal } from '../auth/principal';
import { preflight } from '../sources/gates';
import {
  assertDispatchedOrRollback,
  dispatchIngestionJobs,
  type DispatchableJob,
} from '../sources/dispatch';
import {
  QuotaExceededBodySchema,
  RateLimitedBodySchema,
} from '../sources/schemas';
import { createSources } from '../sources/service';
import {
  IngestConversationRequestSchema,
  IngestConversationResponseSchema,
} from './schemas';
import { formatMessages } from './sessions';

export const conversationRoutes = createApiApp();

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
      'Ingest a multi-turn conversation. The conversation is stored as a single source and segmented at ingestion into windows of 4 turns; each window is extracted independently with the prior window as lookback context for pronoun resolution.',
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
      source_count: 1,
    });

    const limits = getOperationalLimits(c.env);
    const limiter = getRateLimiter(c.env);
    const queue = getQueueService(c.env, db);
    const jobStore = getJobStore(db, limits.staleJobMinutes);

    const preflightStart = performance.now();
    const space = await preflight({
      db,
      limiter,
      queue,
      jobStore,
      limits,
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
    const meta: Record<string, unknown> = { session_id: sessionId };
    if (body.session_date) meta.date = body.session_date;
    if (body.meta) Object.assign(meta, body.meta);

    const inserts = [{
      scope,
      content: formatMessages(body.messages),
      contentType: 'conversation' as const,
      visibility: body.visibility,
      meta,
    }];
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
    const dispatchable: DispatchableJob = {
      jobId,
      sourceIds: created.map((s) => s.id),
      message: {
        task: 'process_ingestion' as const,
        job_id: jobId,
        correlation_id: correlationId,
        org_id: space.orgId,
        space_id: space.id,
        user_id: userId,
        source_ids: created.map((s) => s.id),
        enqueued_at_ms: enqueuedAtMs,
      },
    };
    // Durable enqueue (backstop) + low-latency RPC kick, with outcome tracking:
    // if BOTH fail (startup race / ingestion binding down) the rows are rolled
    // back and we 503 rather than 202 over an orphaned `pending` job. See #2.
    const dispatchResult = await logger.time('ingestion.enqueue_stage_completed', {
      stage: 'queue_enqueue',
      space_id: space.id,
      error_category: 'external_service',
      dependency: 'queue',
    }, () => dispatchIngestionJobs(queue, [dispatchable]));
    await assertDispatchedOrRollback(db, logger, {
      orgId: space.orgId,
      spaceId: space.id,
      jobs: [dispatchable],
      result: dispatchResult,
    });
    logger.info('ingestion.enqueue_accepted', {
      space_id: space.id,
      source_count: created.length,
      duration_ms: durationMs(enqueueStart),
    });

    return c.json(
      {
        job_id: jobId,
        status: 'pending' as const,
        source_id: created[0]!.uuid,
      },
      202,
    );
  },
);
