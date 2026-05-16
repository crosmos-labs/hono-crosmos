import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
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
