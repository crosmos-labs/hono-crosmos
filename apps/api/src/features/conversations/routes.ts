import { createRoute, z } from '@hono/zod-openapi';
import { createApiApp } from '../../lib/openapi';
import {
  createLogger,
  createMetrics,
  createStageRecorder,
  type TraceProvider,
} from '@crosmos/observability';
import { assertKeyScopeAllowsSpace } from '../../lib/key-scope';
import { getDb } from '../../db';
import { getJobStore } from '../../integrations/job-store';
import { getQueueService } from '../../integrations/queue';
import { getRateLimiter } from '../../integrations/rate-limit';
import { getOperationalLimits } from '../../lib/limits';
import type { TenantScope } from '../../lib/scope';
import { requireAuth } from '../auth/middleware';
import { requirePrincipal } from '../auth/principal';
import { preflight } from '../sources/gates';
import { HTTPException } from 'hono/http-exception';
import {
  assertDispatchedOrRollback,
  dispatchIngestionJobs,
  pendingCapError,
  rollbackJobsAndSources,
  type DispatchableJob,
} from '../sources/dispatch';
import {
  QuotaExceededBodySchema,
  RateLimitedBodySchema,
} from '../sources/schemas';
import { createSources } from '../sources/service';
import { estimateTokens } from '../../lib/tokens';
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
    logger.info('ingestion.enqueue_started', {
      source_count: 1,
    });
    const metrics = createMetrics(c.env.ANALYTICS, {
      service: 'api',
      environment: c.env.ENVIRONMENT,
      version: c.env.CF_VERSION_METADATA?.id,
    });
    const tracing = (c.executionCtx as ExecutionContext & { tracing?: TraceProvider }).tracing;
    const stages = createStageRecorder({
      logger,
      metrics,
      tracing,
      event: 'ingestion.enqueue_stage_completed',
      metric: 'api_stage',
    });

    return stages.time('ingestion_enqueue_total', { source_count: 1 }, async () => {
      const limits = getOperationalLimits(c.env);
      const limiter = getRateLimiter(c.env);
      const queue = getQueueService(c.env, db);
      const jobStore = getJobStore(db, limits.staleJobMinutes);

      // Formatted once: feeds the input-token estimate (quota basis) AND the
      // stored source content below.
      const conversationContent = formatMessages(body.messages);
      const incomingTokens = estimateTokens(conversationContent);

      const space = await stages.time('ingestion_preflight', {}, () =>
        preflight({
          db,
          limiter,
          queue,
          jobStore,
          limits,
          orgId,
          userId,
          spaceUuid: body.space_id,
          incomingTokens,
          skipPlanRateLimit: c.var.planRateLimitEnforced,
        }),
      );
      // A space-scoped API key may only ingest into its pinned space (no-op for
      // JWT / org-wide keys).
      assertKeyScopeAllowsSpace(c, space.id);

      const scope: TenantScope = {
        orgId: space.orgId,
        spaceId: space.id,
        userId,
      };

      const sessionId = body.session_id ?? crypto.randomUUID();
      const meta: Record<string, unknown> = { session_id: sessionId };
      if (body.session_date) meta.date = body.session_date;
      if (body.meta) Object.assign(meta, body.meta);

      const inserts = [
        {
          scope,
          content: conversationContent,
          contentType: 'conversation' as const,
          visibility: body.visibility,
          meta,
          tokenCount: incomingTokens,
        },
      ];
      const created = await stages.time(
        'ingestion_source_insert',
        {
          space_id: space.id,
          source_count: inserts.length,
          error_category: 'internal',
          dependency: 'database',
        },
        () => createSources(db, inserts),
        (rows) => ({
          inputCount: inserts.length,
          outputCount: rows.length,
        }),
      );

      const jobId = crypto.randomUUID();
      const correlationId = crypto.randomUUID();
      // Everything after the source INSERT is wrapped so any failure rolls the
      // source (and job, if created) back — `createSources` autocommits, so an
      // unhandled throw here would otherwise orphan a `pending` source that only
      // the cron sweep could ever recover (issue #6).
      try {
        // Atomic per-user pending cap (issue #6) — authoritative, matching
        // `/sources`. `jobStore.create` had no cap, leaving a TOCTOU race vs the
        // advisory preflight check.
        const ok = await stages.time(
          'ingestion_job_create',
          {
            space_id: space.id,
            error_category: 'internal',
            dependency: 'database',
          },
          () =>
            jobStore.createWithActiveCap(
              {
                jobId,
                orgId: space.orgId,
                spaceId: space.id,
                userId,
                sourceIds: created.map((s) => s.id),
              },
              limits.maxPendingJobsPerUser,
            ),
        );
        if (!ok) {
          await rollbackJobsAndSources(db, {
            orgId: space.orgId,
            spaceId: space.id,
            jobIds: [],
            sourceIds: created.map((s) => s.id),
          });
          logger.warn('ingestion.request_rejected', {
            stage: 'pending_cap',
            space_id: space.id,
            status_code: 429,
          });
          throw pendingCapError();
        }

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
          await stages.time(
          'ingestion_dispatch',
          {
            space_id: space.id,
            error_category: 'external_service',
            dependency: 'queue',
          },
          async () => {
            const result = await dispatchIngestionJobs(queue, [dispatchable]);
            await assertDispatchedOrRollback(db, logger, {
              orgId: space.orgId,
              spaceId: space.id,
              jobs: [dispatchable],
              result,
            });
            return result;
          },
          { inputCount: 1 },
          );
        logger.info('ingestion.enqueue_accepted', {
          space_id: space.id,
          source_count: created.length,
        });

        return c.json(
          {
            job_id: jobId,
            status: 'pending' as const,
            source_id: created[0]!.uuid,
          },
          202,
        );
      } catch (err) {
        // HTTPExceptions (429 cap / 503 dispatch) already settled their own
        // rollback — just propagate. Anything else is an unexpected failure after
        // the source committed: clean up the orphaned source + job before rethrow.
        if (err instanceof HTTPException) throw err;
        await rollbackJobsAndSources(db, {
          orgId: space.orgId,
          spaceId: space.id,
          jobIds: [jobId],
          sourceIds: created.map((s) => s.id),
        }).catch((rbErr) => {
          logger.error('ingestion.rollback_failed', { space_id: space.id }, rbErr);
        });
        throw err;
      }
    });
  },
);
