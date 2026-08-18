import { createRoute, z } from '@hono/zod-openapi';
import { createApiApp } from '../../lib/openapi';
import { HTTPException } from 'hono/http-exception';
import { getDb } from '../../db';
import { getJobStore } from '../../integrations/job-store';
import { ErrorResponseSchema, UuidSchema } from '../../lib/zod-common';
import { requireAuth } from '../auth/middleware';
import { requirePrincipal } from '../auth/principal';
import { JobResponseSchema } from './schemas';

export const jobRoutes = createApiApp();

const ErrorBody = ErrorResponseSchema;

// GET /api/v1/jobs/{job_id} — poll status. Ownership enforced (404 cross-user).
jobRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/{job_id}',
    tags: ['jobs'],
    summary: 'Get Job',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requirePrincipal] as const,
    request: { params: z.object({ job_id: UuidSchema }) },
    responses: {
      200: {
        description: 'Job',
        content: { 'application/json': { schema: JobResponseSchema } },
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
    const { job_id } = c.req.valid('param');
    const db = getDb(c);
    const userId = c.var.userId!;
    const orgId = c.var.activeOrgId!;

    // Scope by both user AND active org (defense-in-depth: a job lookup must
    // never cross the tenant boundary even if user↔job attribution changes).
    const job = await getJobStore(db).get(job_id, { userId, orgId });
    if (!job) {
      throw new HTTPException(404, { message: `Job ${job_id} not found` });
    }

    return c.json(
      {
        job_id: job.jobId,
        status: job.status,
        source_ids: job.sourceIds,
        result: job.result,
        error_message: job.errorMessage,
        created_at: job.createdAt.toISOString(),
        started_at: job.startedAt ? job.startedAt.toISOString() : null,
        completed_at: job.completedAt ? job.completedAt.toISOString() : null,
      },
      200,
    );
  },
);
