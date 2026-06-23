import { createDb, sources, type Database } from '@crosmos/db';
import { createLogger } from '@crosmos/observability';
import { and, gt, inArray, lt, or, sql } from 'drizzle-orm';
import type { Env } from '../../bindings';
import { getJobStore, reapStaleIngestionJobs } from '../../integrations/job-store';
import { getQueueService } from '../../integrations/queue';
import { getOperationalLimits } from '../../lib/limits';
import { MAX_SOURCES_PER_JOB } from '../sources/constants';

/**
 * Cron entrypoint for the stale-job reaper (issue #3). Flips jobs orphaned by a
 * crashed worker to `failed` so they stop pinning the admission gates and become
 * terminal for cleanup. Owns its own connection, like `runIngestionRedrive`.
 */
export async function reapStaleJobs(env: Env): Promise<number> {
  const db = createDb(env.HYPERDRIVE.connectionString);
  return reapStaleIngestionJobs(db, getOperationalLimits(env).staleJobMinutes);
}

/**
 * Ingestion re-drive sweep — the durability backstop of last resort.
 *
 * The fast path (RPC), the queue, the per-source retry, and the job lease
 * recover *transient* failures within minutes. This sweep recovers the residue
 * those miss, so "a source that got a 202 is eventually ingested" holds even
 * across rare wedges:
 *   - sources left `failed` by a non-transient error that has since cleared
 *     (provider outage, the Qdrant subrequest ceiling before the cap landed);
 *   - sources whose job was dead-lettered (queue retries exhausted);
 *   - sources stuck `pending`/`processing` because enqueue/kick failed or the
 *     queue copy was lost.
 *
 * A source is re-driven by minting a FRESH job for it and flipping it back to
 * `pending`; the pipeline's `purgeSourceArtifacts` makes reprocessing
 * idempotent (no duplicate memories/vectors). Re-drives are bounded per source
 * (`redrive_attempts` in `meta`) so genuinely poison input can't loop forever.
 */

/** Stop re-driving a source after this many sweep-initiated attempts. */
const MAX_REDRIVE_ATTEMPTS = 5;
/**
 * Only treat `processing`/`pending` sources as orphaned once they've been stale
 * this long — comfortably past the queue backstop window (max_retries ×
 * BACKSTOP_RETRY_DELAY = 15 min) so we never race a healthy in-flight job.
 */
const STUCK_MINUTES = 20;
/** Debounce `failed` sources briefly so we don't race a just-finished job. */
const FAILED_DEBOUNCE_MINUTES = 2;
/** Don't resurrect ancient abandoned data — ignore sources older than this. */
const RECENCY_WINDOW_DAYS = 7;
/** Cap sources touched per sweep so one run stays bounded. */
const MAX_SOURCES_PER_SWEEP = 500;

export interface RedriveResult {
  candidates: number;
  jobsCreated: number;
  sourcesRequeued: number;
  skippedNoOwner: number;
  /** No-owner sources marked terminally `failed` so they leave limbo (issue #6). */
  markedOwnerDeleted: number;
  /** Budget-exhausted stuck sources marked terminally `failed` (issue #6). */
  markedExhausted: number;
  capHit: boolean;
}

/**
 * Drive a set of stuck sources to a terminal `failed` state with a reason in
 * `meta`, so abandoned rows leave `pending`/`processing` limbo and surface in
 * monitoring instead of being silently skipped forever (issue #6). Scoped to the
 * given ids; returns how many rows were updated.
 */
async function markSourcesTerminallyFailed(
  db: Database,
  ids: number[],
  reason: string,
  flag: string,
): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .update(sources)
    .set({
      extractionStatus: 'failed',
      updatedAt: new Date(),
      meta: sql`coalesce(${sources.meta}, '{}'::jsonb) || ${JSON.stringify({ error_message: reason, [flag]: true })}::jsonb`,
    })
    .where(inArray(sources.id, ids))
    .returning({ id: sources.id });
  return rows.length;
}

export async function runIngestionRedrive(env: Env): Promise<RedriveResult> {
  const db = createDb(env.HYPERDRIVE.connectionString);
  return redriveStuckSources(db, env);
}

export async function redriveStuckSources(
  db: Database,
  env: Env,
): Promise<RedriveResult> {
  const logger = createLogger({ service: 'api', environment: env.ENVIRONMENT });
  const result: RedriveResult = {
    candidates: 0,
    jobsCreated: 0,
    sourcesRequeued: 0,
    skippedNoOwner: 0,
    markedOwnerDeleted: 0,
    markedExhausted: 0,
    capHit: false,
  };

  const now = Date.now();
  const recencyFloor = new Date(now - RECENCY_WINDOW_DAYS * 86_400_000);
  const failedCutoff = new Date(now - FAILED_DEBOUNCE_MINUTES * 60_000);
  const stuckCutoff = new Date(now - STUCK_MINUTES * 60_000);
  const attempts = sql<number>`coalesce((${sources.meta}->>'redrive_attempts')::int, 0)`;

  // Candidates: not-completed sources past their settle window, within the
  // recency window, under the per-source re-drive budget.
  const candidates = await db
    .select({
      id: sources.id,
      orgId: sources.orgId,
      spaceId: sources.spaceId,
      ownerUserId: sources.ownerUserId,
    })
    .from(sources)
    .where(
      and(
        gt(sources.updatedAt, recencyFloor),
        sql`${attempts} < ${MAX_REDRIVE_ATTEMPTS}`,
        or(
          and(
            sql`${sources.extractionStatus} = 'failed'`,
            lt(sources.updatedAt, failedCutoff),
          ),
          and(
            sql`${sources.extractionStatus} in ('pending','processing')`,
            lt(sources.updatedAt, stuckCutoff),
          ),
        ),
      ),
    )
    .orderBy(sources.updatedAt)
    .limit(MAX_SOURCES_PER_SWEEP);

  result.candidates = candidates.length;

  // Budget-exhausted cleanup (issue #6) — runs independently of the candidate
  // set. Sources that burned through their re-drive budget (attempts >= MAX)
  // while still non-terminal are excluded from the candidate query above and
  // would otherwise sit `pending`/`processing` forever. Mark them terminally
  // failed so they leave limbo and surface in monitoring.
  const exhausted = await db
    .select({ id: sources.id })
    .from(sources)
    .where(
      and(
        gt(sources.updatedAt, recencyFloor),
        sql`${attempts} >= ${MAX_REDRIVE_ATTEMPTS}`,
        sql`${sources.extractionStatus} in ('pending','processing')`,
        lt(sources.updatedAt, stuckCutoff),
      ),
    )
    .limit(MAX_SOURCES_PER_SWEEP);
  result.markedExhausted = await markSourcesTerminallyFailed(
    db,
    exhausted.map((s) => s.id),
    'Ingestion re-drive budget exhausted',
    'redrive_exhausted',
  );

  if (candidates.length === 0) return result;

  // Group by tenant (org, space, owner) — a job is scoped to one (org, space,
  // user). Sources whose owner was deleted (owner_user_id NULL) can't form a
  // job: collect them and mark them terminally failed (they can never re-drive).
  const groups = new Map<string, { orgId: number; spaceId: number; userId: number; ids: number[] }>();
  const noOwnerIds: number[] = [];
  for (const s of candidates) {
    if (s.ownerUserId == null) {
      result.skippedNoOwner++;
      noOwnerIds.push(s.id);
      continue;
    }
    const key = `${s.orgId}:${s.spaceId}:${s.ownerUserId}`;
    const g = groups.get(key);
    if (g) g.ids.push(s.id);
    else groups.set(key, { orgId: s.orgId, spaceId: s.spaceId, userId: s.ownerUserId, ids: [s.id] });
  }
  result.markedOwnerDeleted = await markSourcesTerminallyFailed(
    db,
    noOwnerIds,
    'Source owner was deleted; cannot re-drive ingestion',
    'owner_deleted',
  );

  const limits = getOperationalLimits(env);
  const jobStore = getJobStore(db, limits.staleJobMinutes);
  const queue = getQueueService(env, db);
  const correlationId = crypto.randomUUID();
  const enqueuedAtMs = now;

  for (const g of groups.values()) {
    for (let i = 0; i < g.ids.length; i += MAX_SOURCES_PER_JOB) {
      const chunk = g.ids.slice(i, i + MAX_SOURCES_PER_JOB);
      try {
        const jobId = crypto.randomUUID();
        const ok = await jobStore.createWithActiveCap(
          { jobId, orgId: g.orgId, spaceId: g.spaceId, userId: g.userId, sourceIds: chunk },
          limits.maxPendingJobsPerUser,
        );
        if (!ok) {
          // User is at the pending cap — leave these for a later sweep.
          result.capHit = true;
          continue;
        }

        // Flip sources back to pending and bump their re-drive counter so the
        // budget is enforced and they aren't re-selected until they go stale
        // again (updated_at is bumped here).
        await db
          .update(sources)
          .set({
            extractionStatus: 'pending',
            updatedAt: new Date(),
            meta: sql`jsonb_set(coalesce(${sources.meta}, '{}'::jsonb), '{redrive_attempts}', to_jsonb(coalesce((${sources.meta}->>'redrive_attempts')::int, 0) + 1))`,
          })
          .where(inArray(sources.id, chunk));

        const jobMessage = {
          task: 'process_ingestion' as const,
          job_id: jobId,
          correlation_id: correlationId,
          org_id: g.orgId,
          space_id: g.spaceId,
          user_id: g.userId,
          source_ids: chunk,
          enqueued_at_ms: enqueuedAtMs,
        };
        try {
          await queue.enqueue(jobMessage);
        } catch (err) {
          // The job + pending sources are committed; the NEXT sweep re-drives
          // them if this enqueue (and the kick below) didn't take.
          logger.warn('ingestion.redrive_enqueue_failed', { job_id: jobId }, err);
        }
        try {
          await queue.kick(jobMessage);
        } catch {
          /* best-effort fast start; queue copy / next sweep covers it */
        }

        result.jobsCreated++;
        result.sourcesRequeued += chunk.length;
      } catch (err) {
        logger.error(
          'ingestion.redrive_chunk_failed',
          { org_id: g.orgId, space_id: g.spaceId, user_id: g.userId },
          err,
        );
      }
    }
  }

  logger.info('ingestion.redrive_completed', {
    candidates: result.candidates,
    jobs_created: result.jobsCreated,
    sources_requeued: result.sourcesRequeued,
    skipped_no_owner: result.skippedNoOwner,
    marked_owner_deleted: result.markedOwnerDeleted,
    marked_exhausted: result.markedExhausted,
    cap_hit: result.capHit,
  });
  return result;
}
