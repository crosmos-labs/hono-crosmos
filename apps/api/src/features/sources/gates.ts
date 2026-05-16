import type { Database, MemorySpace } from '@crosmos/db';
import { HTTPException } from 'hono/http-exception';
import {
  QuotaExceededError,
  checkQuota,
} from '../orgs/entitlements';
import {
  enforcePlanRateLimit,
  type RateLimiter,
  RateLimitError,
} from '../../integrations/rate-limit';
import type { JobStore } from '../../integrations/job-store';
import type { QueueService } from '../../integrations/queue';
import { getSpaceByUuid } from '../spaces/service';
import {
  MAX_PENDING_JOBS_PER_USER,
  MAX_QUEUE_DEPTH,
  RETRY_AFTER_SECONDS,
} from './constants';

/**
 * Producer-side pre-flight gates applied to both `POST /sources` and
 * `POST /conversations`. Order matches Python and
 * docs/ingestion_migration/api-routes.md so error precedence stays
 * predictable for clients.
 *
 * Throws `HTTPException` with the structured error body conventions from
 * the docs:
 *   - `{detail: {error: 'rate_limited', scope, limit, count}}` + Retry-After
 *   - 503 + Retry-After when global queue depth is at the cap
 *   - `{detail: '...'}` plain string for per-user pending cap
 *   - 404 for cross-tenant space access
 *   - `{detail: {error: 'quota_exceeded', key, limit, used}}` for monthly cap
 *
 * Returns the resolved `MemorySpace` so the caller doesn't repeat the
 * lookup.
 */
export async function preflight(input: {
  db: Database;
  limiter: RateLimiter;
  queue: QueueService;
  jobStore: JobStore;
  orgId: number;
  userId: number;
  spaceUuid: string;
}): Promise<MemorySpace> {
  // 1. Plan rate limit (per-org RPM/RPD).
  try {
    await enforcePlanRateLimit(input.db, input.limiter, input.orgId);
  } catch (err) {
    if (err instanceof RateLimitError) {
      throw new HTTPException(429, {
        res: jsonError(
          {
            error: 'rate_limited',
            scope: err.scope,
            limit: err.limit,
            count: err.count,
          },
          429,
          { 'Retry-After': String(err.retryAfterSeconds) },
        ),
      });
    }
    throw err;
  }

  // 2. Global queue depth.
  const depth = await input.queue.queueDepth();
  if (depth >= MAX_QUEUE_DEPTH) {
    throw new HTTPException(503, {
      res: jsonError('Ingestion queue is full. Retry later.', 503, {
        'Retry-After': String(RETRY_AFTER_SECONDS),
      }),
    });
  }

  // 3. Per-user pending cap.
  const activeJobs = await input.jobStore.countActive(input.userId);
  if (activeJobs >= MAX_PENDING_JOBS_PER_USER) {
    throw new HTTPException(429, {
      res: jsonError(
        `Too many pending jobs (${activeJobs}). Wait for existing jobs to complete.`,
        429,
      ),
    });
  }

  // 4. Space access — 404 on missing OR cross-tenant (no existence leak).
  const space = await getSpaceByUuid(input.db, input.spaceUuid);
  if (!space || space.orgId !== input.orgId) {
    throw new HTTPException(404, {
      res: jsonError(`Space ${input.spaceUuid} not found`, 404),
    });
  }

  // 5. Monthly token quota.
  try {
    await checkQuota(input.db, input.orgId, 'monthly_tokens_ingested', 0);
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      throw new HTTPException(429, {
        res: jsonError(
          {
            error: 'quota_exceeded',
            key: err.key,
            limit: err.limit,
            used: err.used,
          },
          429,
        ),
      });
    }
    throw err;
  }

  return space;
}

function jsonError(
  detail: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ detail }), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
