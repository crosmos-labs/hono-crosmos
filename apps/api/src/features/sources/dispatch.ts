import { ingestionJobs, sources, type Database } from '@crosmos/db';
import type { Logger } from '@crosmos/observability';
import type { IngestionJobMessage } from '@crosmos/types';
import { and, eq, inArray } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import type { QueueService } from '../../integrations/queue';
import { RETRY_AFTER_SECONDS } from './constants';

/**
 * How durably a single ingestion job got dispatched off the producer:
 *  - `durable`   — enqueued onto the queue; the queue runtime guarantees
 *                  eventual delivery (retry + DLQ) even if the RPC kick is lost.
 *  - `fast_only` — enqueue failed but the kick took, so the job is running NOW
 *                  via the RPC fast path but has NO durable backstop; a
 *                  mid-flight isolate death leaves recovery to the re-drive sweep.
 *  - `failed`    — neither path accepted the job; it is undispatched and will
 *                  sit `pending` until the re-drive sweep mints a fresh job
 *                  (and locally, where the cron never fires, never — see #2).
 */
export type JobDispatchStatus = 'durable' | 'fast_only' | 'failed';

export interface DispatchableJob {
  jobId: string;
  /** Source row ids (numeric PKs) this job owns — used for rollback. */
  sourceIds: number[];
  message: IngestionJobMessage;
}

export interface DispatchResult {
  statuses: Map<string, JobDispatchStatus>;
  /** Jobs where BOTH enqueue and kick failed (truly undispatched). */
  failed: DispatchableJob[];
  /** Jobs that started but without a durable queue copy. */
  degraded: DispatchableJob[];
}

async function attempt(task: () => Promise<unknown>): Promise<boolean> {
  try {
    await task();
    return true;
  } catch {
    return false;
  }
}

/**
 * Dispatch one job: durable enqueue (backstop) + low-latency RPC kick (fast
 * path). The enqueue is retried once — it is the durability-bearing call, so a
 * single transient blip (a consumer still warming during a deploy) shouldn't
 * strip a job of its backstop. The kick's `ingest()` RPC returns as soon as the
 * consumer has *scheduled* the run, so awaiting it costs ~one round-trip, not
 * the ingestion runtime — cheap enough to learn the outcome on the response path.
 */
async function dispatchOne(
  queue: QueueService,
  message: IngestionJobMessage,
): Promise<JobDispatchStatus> {
  let enqueued = await attempt(() => queue.enqueue(message));
  if (!enqueued) enqueued = await attempt(() => queue.enqueue(message));
  const kicked = await attempt(() => queue.kick(message));
  if (enqueued) return 'durable';
  if (kicked) return 'fast_only';
  return 'failed';
}

/**
 * Dispatch every job in a batch concurrently and classify the outcomes.
 *
 * Concurrency keeps response latency at ~one round-trip regardless of how many
 * jobs a request fanned into (a 100-source request can be 10 jobs). The caller
 * decides what to do with `failed`/`degraded` — see `assertDispatchedOrRollback`.
 */
export async function dispatchIngestionJobs(
  queue: QueueService,
  jobs: DispatchableJob[],
): Promise<DispatchResult> {
  const outcomes = await Promise.all(
    jobs.map(async (job) => [job, await dispatchOne(queue, job.message)] as const),
  );
  const statuses = new Map<string, JobDispatchStatus>();
  const failed: DispatchableJob[] = [];
  const degraded: DispatchableJob[] = [];
  for (const [job, status] of outcomes) {
    statuses.set(job.jobId, status);
    if (status === 'failed') failed.push(job);
    else if (status === 'fast_only') degraded.push(job);
  }
  return { statuses, failed, degraded };
}

/**
 * Delete a set of job rows and their source rows. Used to undo a request whose
 * jobs could not be dispatched at all, so the client can retry cleanly instead
 * of leaving orphaned `pending` rows behind (which would then be re-ingested as
 * duplicates alongside the retry's fresh rows).
 */
export async function rollbackJobsAndSources(
  db: Database,
  input: { orgId: number; spaceId: number; jobIds: string[]; sourceIds: number[] },
): Promise<void> {
  if (input.jobIds.length > 0) {
    await db.delete(ingestionJobs).where(inArray(ingestionJobs.id, input.jobIds));
  }
  if (input.sourceIds.length > 0) {
    await db
      .delete(sources)
      .where(
        and(
          eq(sources.orgId, input.orgId),
          eq(sources.spaceId, input.spaceId),
          inArray(sources.id, input.sourceIds),
        ),
      );
  }
}

/**
 * The producer-side contract for #2: never return 202 for a batch that got
 * NOWHERE. If every job both failed to enqueue AND failed to kick (the classic
 * startup race — api ready a beat before the ingestion worker, or the ingestion
 * service binding unreachable), the rows are rolled back and a 503 + Retry-After
 * is thrown so the client retries cleanly. Partial failures keep their rows and
 * lean on the re-drive sweep (and are logged for visibility); a partial batch
 * still made forward progress, so we don't punish the successful jobs.
 */
export async function assertDispatchedOrRollback(
  db: Database,
  logger: Logger,
  input: {
    orgId: number;
    spaceId: number;
    jobs: DispatchableJob[];
    result: DispatchResult;
  },
): Promise<void> {
  const { jobs, result } = input;
  if (result.failed.length === jobs.length) {
    // Nothing got out — roll back so there are no orphans and the retry is clean.
    await rollbackJobsAndSources(db, {
      orgId: input.orgId,
      spaceId: input.spaceId,
      jobIds: jobs.map((j) => j.jobId),
      sourceIds: jobs.flatMap((j) => j.sourceIds),
    });
    logger.error('ingestion.dispatch_total_failure', {
      space_id: input.spaceId,
      job_count: jobs.length,
      status_code: 503,
    });
    throw new HTTPException(503, {
      res: new Response(
        JSON.stringify({
          detail: 'Ingestion service unavailable. Retry shortly.',
        }),
        {
          status: 503,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(RETRY_AFTER_SECONDS),
          },
        },
      ),
    });
  }

  if (result.failed.length > 0) {
    logger.warn('ingestion.dispatch_partial_failure', {
      space_id: input.spaceId,
      failed_job_count: result.failed.length,
      failed_job_ids: result.failed.map((j) => j.jobId),
      total_job_count: jobs.length,
    });
  }
  if (result.degraded.length > 0) {
    logger.warn('ingestion.dispatch_degraded', {
      space_id: input.spaceId,
      degraded_job_count: result.degraded.length,
      degraded_job_ids: result.degraded.map((j) => j.jobId),
      reason: 'enqueue_failed_kick_ok',
    });
  }
}
