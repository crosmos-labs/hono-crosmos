/**
 * Consumer-side job lifecycle persistence.
 * port (create, get, countActive, cancel*) — the ingestion worker only needs
 * the subset used inside the queue handler: status reads, status writes,
 * cancellation checks. Mirroring the relevant operations from
 * `apps/api/src/integrations/job-store/pg.ts` so cross-app coupling stays
 * minimal (we'd promote to `packages/db/` only if drift becomes a problem).
 */
import { ingestionJobs, memorySpaces, sql, type Database } from '@crosmos/db';
import type {
  IngestionJobResult,
  IngestionJobStatus,
} from '@crosmos/types';
import { and, eq, isNull, notInArray } from 'drizzle-orm';

export interface UpdateStatusOptions {
  result?: IngestionJobResult;
  error?: string;
  stage?: string;
}

const TERMINAL_STATUSES: ReadonlySet<IngestionJobStatus> = new Set([
  'completed',
  'partial',
  'failed',
  'cancelled',
]);

/**
 * Outcome of an atomic claim attempt:
 *  - `claimed`    — we now own the job; proceed to process it.
 *  - `terminal`   — already finished (a redelivery / the other trigger won).
 *  - `not_found`  — no such job row.
 *  - `in_flight`  — another trigger holds a live (un-expired) lease; do NOT
 *                   process, but the caller may want to re-check later.
 */
export type ClaimResult = 'claimed' | 'terminal' | 'not_found' | 'in_flight';

/**
 * Atomically claim a job for processing. This is the single coordination point
 * between the two triggers that can start a job: the direct service-binding RPC
 * (fast path) and the Cloudflare Queue delivery (durable backstop).
 *
 * The claim is a compare-and-swap: `pending -> processing`, OR a `processing`
 * job whose `started_at` is older than the lease (its previous owner is
 * presumed dead). Postgres serialises the conditional UPDATE, so exactly one
 * concurrent caller gets the row back via RETURNING — the rest get a non-claim
 * result and bow out. No double-processing of a healthy in-flight job; reliable
 * recovery of an abandoned one once the lease lapses.
 *
 * The "healthy in-flight" guarantee depends on the lease HEARTBEAT: a running
 * job re-stamps `started_at` per source via `updateJobStatus('processing')`, so
 * `started_at < leaseCutoff` is only ever true for a job that has made no
 * progress for `leaseMs`. See the load-bearing note in `updateJobStatus`.
 */
export async function claimJob(
  db: Database,
  jobId: string,
  leaseMs: number,
): Promise<ClaimResult> {
  const now = new Date();
  const leaseCutoff = new Date(now.getTime() - leaseMs);
  // Return the claim result AND the failed-CAS classification from one
  // statement. Queue-backstop deliveries normally lose this CAS to the RPC
  // fast path; the old implementation then paid a second Postgres round trip
  // merely to learn `in_flight`. The data-modifying CTE keeps the same atomic
  // UPDATE predicate while making every outcome one trip.
  const rows = await db.execute<{ outcome: ClaimResult }>(sql`
    WITH claimed AS (
      UPDATE ${ingestionJobs}
      SET status = 'processing', started_at = ${now.toISOString()}::timestamptz
      WHERE ${ingestionJobs.id} = ${jobId}::uuid
        AND (
          ${ingestionJobs.status} = 'pending'
          OR (
            ${ingestionJobs.status} = 'processing'
            AND ${ingestionJobs.startedAt} < ${leaseCutoff.toISOString()}::timestamptz
          )
        )
      RETURNING 1
    )
    SELECT 'claimed'::text AS outcome
    FROM claimed
    UNION ALL
    SELECT CASE
      WHEN ${ingestionJobs.status} IN ('completed', 'partial', 'failed', 'cancelled')
        THEN 'terminal'::text
      ELSE 'in_flight'::text
    END AS outcome
    FROM ${ingestionJobs}
    WHERE ${ingestionJobs.id} = ${jobId}::uuid
      AND NOT EXISTS (SELECT 1 FROM claimed)
    LIMIT 1
  `);
  return rows[0]?.outcome ?? 'not_found';
}

export async function getJobStatus(
  db: Database,
  jobId: string,
): Promise<IngestionJobStatus | null> {
  const rows = await db
    .select({ status: ingestionJobs.status })
    .from(ingestionJobs)
    .where(eq(ingestionJobs.id, jobId))
    .limit(1);
  return rows[0]?.status ?? null;
}

export async function isJobCancelled(
  db: Database,
  jobId: string,
): Promise<boolean> {
  return (await getJobStatus(db, jobId)) === 'cancelled';
}

/**
 * Conditionally reset a wedged job back to `pending` so the queue backstop can
 * re-claim it promptly, instead of waiting out the full lease (`JOB_LEASE_MS`).
 *
 * Used on the RPC fast-path failure: if the background run threw AFTER claiming
 * the job, the row sits in `processing` and recovery would otherwise depend on
 * the lease lapsing. This is a guarded CAS — it only flips a row that is STILL
 * `processing` (i.e. we presumably still own the claim). It will NOT clobber a
 * job another trigger has already driven terminal or re-claimed-and-finished,
 * because those rows are no longer `processing` (terminal) — and a job the
 * backstop legitimately re-claimed mid-flight only happens after the lease has
 * expired, by which point this RPC run is long gone. `started_at` is cleared so
 * the very next claim sees a `pending` row.
 *
 * Returns true if a row was reset.
 */
export async function resetJobForRetry(
  db: Database,
  jobId: string,
): Promise<boolean> {
  const rows = await db
    .update(ingestionJobs)
    .set({ status: 'pending', startedAt: null, currentStage: null })
    .where(
      and(
        eq(ingestionJobs.id, jobId),
        eq(ingestionJobs.status, 'processing'),
      ),
    )
    .returning({ id: ingestionJobs.id });
  return rows.length > 0;
}

export async function updateJobStatus(
  db: Database,
  jobId: string,
  status: IngestionJobStatus,
  opts: UpdateStatusOptions = {},
): Promise<boolean> {
  const now = new Date();
  const values: Record<string, unknown> = { status };
  // LOAD-BEARING — DO NOT REMOVE: re-stamping `started_at` on every
  // `processing` write is the lease HEARTBEAT that `claimJob` reads.
  // `processIngestion` calls this once per source AND mid-source on a throttled
  // per-chunk heartbeat (issue #1), so a healthy long job — even one stuck on a
  // single large multi-chunk source — keeps advancing `started_at`, and the
  // queue backstop never reclaims it mid-run (which would double-process it). The
  // lease (`JOB_LEASE_MS`) is therefore "no progress for N minutes", NOT "whole
  // job under N minutes". Drop this line and large batches / long sources start
  // getting double-claimed. See claimJob and process-ingestion's heartbeat.
  if (status === 'processing') values.startedAt = now;
  if (status === 'completed' || status === 'failed' || status === 'partial') {
    values.completedAt = now;
    values.currentStage = null;
  }
  if (opts.result !== undefined) values.result = opts.result;
  if (opts.error !== undefined) values.errorMessage = opts.error;
  if (opts.stage !== undefined) values.currentStage = opts.stage;

  // Compare-and-set on TERMINALITY. Without this the per-source and per-chunk
  // heartbeats write `status = 'processing'` by job id alone, so a job the API
  // cancelled (space deleted, user cancelled) is silently RESURRECTED to
  // `processing` by the very run that was supposed to be stopping — and the
  // cancellation is then invisible to everyone reading job status.
  //
  // Terminal is final: once a job is completed/partial/failed/cancelled nothing
  // may move it. The caller learns the write did not apply from the return
  // value and can stop early.
  const updated = await db
    .update(ingestionJobs)
    .set(values)
    .where(
      and(
        eq(ingestionJobs.id, jobId),
        notInArray(ingestionJobs.status, [...TERMINAL_STATUSES]),
      ),
    )
    .returning({ id: ingestionJobs.id });
  return updated.length > 0;
}

/**
 * Is this job's space still active (not tombstoned)?
 *
 * Deferred deletion means `DELETE /spaces/{uuid}` returns 204 immediately while
 * a job may still be mid-flight. Job cancellation is the primary fence, but it
 * is a separate row: a job created between the tombstone and the cancel sweep,
 * or one whose cancel write lost a race, would otherwise keep writing memories
 * into a space the user has deleted — rows the finalizer then has to clean up,
 * and which are briefly visible if anything reads without the active filter.
 *
 * Checked alongside `isJobCancelled` at the same boundaries. Fails OPEN: if this
 * query throws we continue, because a transient database blip must not silently
 * abandon ingestion. The tombstone is durable, so the next boundary re-checks.
 */
export async function isSpaceActive(
  db: Database,
  spaceId: number,
): Promise<boolean> {
  const rows = await db
    .select({ id: memorySpaces.id })
    .from(memorySpaces)
    .where(and(eq(memorySpaces.id, spaceId), isNull(memorySpaces.deletedAt)))
    .limit(1);
  return rows.length > 0;
}
