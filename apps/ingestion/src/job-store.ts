/**
 * Consumer-side slice of the `JobStore` port. The API worker owns the full
 * port (create, get, countActive, cancel*) — the ingestion worker only needs
 * the subset used inside the queue handler: status reads, status writes,
 * cancellation checks. Mirroring the relevant operations from
 * `apps/api/src/integrations/job-store/pg.ts` so cross-app coupling stays
 * minimal (we'd promote to `packages/db/` only if drift becomes a problem).
 */
import { ingestionJobs, type Database } from '@crosmos/db';
import type {
  IngestionJobResult,
  IngestionJobStatus,
} from '@crosmos/types';
import { and, eq, lt, or } from 'drizzle-orm';

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
  const rows = await db
    .update(ingestionJobs)
    .set({ status: 'processing', startedAt: now })
    .where(
      and(
        eq(ingestionJobs.id, jobId),
        or(
          eq(ingestionJobs.status, 'pending'),
          and(
            eq(ingestionJobs.status, 'processing'),
            lt(ingestionJobs.startedAt, leaseCutoff),
          ),
        ),
      ),
    )
    .returning({ id: ingestionJobs.id });
  if (rows.length > 0) return 'claimed';

  // CAS failed — disambiguate for the caller's ack/retry decision and logs.
  const status = await getJobStatus(db, jobId);
  if (status === null) return 'not_found';
  if (TERMINAL_STATUSES.has(status)) return 'terminal';
  return 'in_flight';
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
): Promise<void> {
  const now = new Date();
  const values: Record<string, unknown> = { status };
  // LOAD-BEARING — DO NOT REMOVE: re-stamping `started_at` on every
  // `processing` write is the lease HEARTBEAT that `claimJob` reads. Because
  // `processIngestion` calls this once per source, a healthy long job keeps
  // advancing `started_at`, so the queue backstop never reclaims it mid-run.
  // The lease (`JOB_LEASE_MS`) is therefore "no progress for N minutes", NOT
  // "whole job under N minutes". Drop this line and large batches (up to
  // MAX_SOURCES_PER_REQUEST) start getting double-claimed. See claimJob.
  if (status === 'processing') values.startedAt = now;
  if (status === 'completed' || status === 'failed' || status === 'partial') {
    values.completedAt = now;
    values.currentStage = null;
  }
  if (opts.result !== undefined) values.result = opts.result;
  if (opts.error !== undefined) values.errorMessage = opts.error;
  if (opts.stage !== undefined) values.currentStage = opts.stage;
  await db.update(ingestionJobs).set(values).where(eq(ingestionJobs.id, jobId));
}
