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
import type { OperationalLimits } from '../../lib/limits';
import { getSpaceByUuid } from '../spaces/service';
import { RETRY_AFTER_SECONDS } from './constants';

/**
 * Producer-side pre-flight gates applied to both `POST /sources` and
 * `POST /conversations`. Order matches Python and .codex/pipelines.md so error
 * precedence stays predictable for clients.
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
  limits: OperationalLimits;
  orgId: number;
  userId: number;
  spaceUuid: string;
  /**
   * Estimated input tokens for this request — checked against the remaining
   * monthly token quota so we reject up front when this request would push the
   * org over, rather than only when it's already over. Defaults to 0 (pure
   * already-over check) for callers that don't pre-compute it.
   */
  incomingTokens?: number;
  /**
   * Skip the strict per-org AI-path rate-limit gate (step 1) when the caller
   * already enforced it. `requireAuth` only applies the looser management limit
   * (different counter), so this is normally false and ingestion enforces the
   * AI limit here. Avoids double-counting the org's RPM/daily quota.
   */
  skipPlanRateLimit?: boolean;
}): Promise<MemorySpace> {
  // 1. Plan rate limit (per-org RPM/RPD).
  try {
    if (!input.skipPlanRateLimit) {
      await enforcePlanRateLimit(input.db, input.limiter, input.orgId);
    }
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

  // 2. Global in-flight-job gate — a coarse account-wide safety valve (NOT the
  // Cloudflare Queue's backlog; see `inFlightJobCount`). The per-user pending
  // cap (gate 3) is the primary admission control; this only trips on aggregate
  // overload. Now bounded to non-stale rows (issue #3) so it can't wedge on a
  // crashed worker's graveyard rows.
  const inFlight = await input.queue.inFlightJobCount();
  if (inFlight >= input.limits.maxQueueDepth) {
    throw new HTTPException(503, {
      res: jsonError('Ingestion queue is full. Retry later.', 503, {
        'Retry-After': String(RETRY_AFTER_SECONDS),
      }),
    });
  }

  // 3. Per-user pending cap.
  const activeJobs = await input.jobStore.countActive(input.userId);
  if (activeJobs >= input.limits.maxPendingJobsPerUser) {
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

  // 5. Monthly token quota — predictive: reject if this request's estimated
  // input tokens would push the org past its monthly cap.
  try {
    await checkQuota(
      input.db,
      input.orgId,
      'monthly_tokens_ingested',
      input.incomingTokens ?? 0,
    );
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
