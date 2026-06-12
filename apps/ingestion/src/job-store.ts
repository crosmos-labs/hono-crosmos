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

export async function updateJobStatus(
  db: Database,
  jobId: string,
  status: IngestionJobStatus,
  opts: UpdateStatusOptions = {},
): Promise<void> {
  const now = new Date();
  const values: Record<string, unknown> = { status };
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
