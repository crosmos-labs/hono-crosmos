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
import { eq } from 'drizzle-orm';

export interface UpdateStatusOptions {
  result?: IngestionJobResult;
  error?: string;
  stage?: string;
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
