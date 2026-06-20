import { ingestionJobs, type Database } from '@crosmos/db';
import type { IngestionJobResult, IngestionJobStatus } from '@crosmos/types';
import { and, count, eq, gt, inArray, lt, or, type SQL, sql } from 'drizzle-orm';
import { STALE_JOB_MINUTES } from '../../features/sources/constants';
import type { JobRow, JobStore, UpdateStatusOptions } from './port';

const ACTIVE_STATUSES: IngestionJobStatus[] = ['pending', 'processing'];

/** `now() - staleMinutes`, evaluated on the DB clock (one source of time). */
function staleCutoff(staleMinutes: number): SQL {
  return sql`now() - (${staleMinutes} * interval '1 minute')`;
}

/**
 * A job counts as "active" (against the pending cap + queue-depth gate) only
 * while it's making progress: `pending` and freshly created, or `processing`
 * and heartbeating. A crashed worker's row goes stale and drops out of the
 * count, so the gates self-heal instead of wedging shut (issue #3). The reaper
 * (`reapStaleIngestionJobs`) later flips those stale rows terminal.
 */
function activeWithinWindow(staleMinutes: number): SQL {
  const cutoff = staleCutoff(staleMinutes);
  return or(
    and(eq(ingestionJobs.status, 'pending'), gt(ingestionJobs.createdAt, cutoff)),
    and(eq(ingestionJobs.status, 'processing'), gt(ingestionJobs.startedAt, cutoff)),
  )!;
}

/**
 * Postgres-backed `JobStore`. Same DB as everything else — no separate store
 * to provision. Mirrors Python's `PgJobStore`.
 */
export class PgJobStore implements JobStore {
  constructor(
    private readonly db: Database,
    /** Staleness window for the active-job gates (issue #3/#6). */
    private readonly staleMinutes: number = STALE_JOB_MINUTES,
  ) {}

  async create(input: {
    jobId: string;
    orgId: number;
    spaceId: number;
    userId: number;
    sourceIds: number[];
  }): Promise<void> {
    await this.db.insert(ingestionJobs).values({
      id: input.jobId,
      orgId: input.orgId,
      spaceId: input.spaceId,
      userId: input.userId,
      sourceIds: input.sourceIds,
      status: 'pending',
    });
  }

  async createWithActiveCap(
    input: {
      jobId: string;
      orgId: number;
      spaceId: number;
      userId: number;
      sourceIds: number[];
    },
    maxActive: number,
  ): Promise<boolean> {
    // Unlimited → plain insert, always succeeds.
    if (maxActive < 0) {
      await this.create(input);
      return true;
    }

    // Guarded INSERT ... SELECT: the row materializes only if the user's live
    // count of ACTIVE (non-stale pending+processing) jobs is under `maxActive`.
    // The count and the insert are evaluated in ONE statement, so concurrent
    // submits can't all slip under the cap (unlike the old count-then-insert).
    // The staleness window (issue #3) keeps a crashed worker's dead `processing`
    // rows from pinning the cap shut. `RETURNING id` yields 1 row on insert,
    // 0 rows when the guard rejected it.
    const sourceIdsJson = JSON.stringify(input.sourceIds);
    const rows = await this.db.execute<{ id: string }>(sql`
      INSERT INTO ingestion_jobs (id, org_id, space_id, user_id, source_ids, status)
      SELECT
        ${input.jobId}::uuid,
        ${input.orgId},
        ${input.spaceId},
        ${input.userId},
        ${sourceIdsJson}::jsonb,
        'pending'
      WHERE (
        SELECT count(*) FROM ingestion_jobs
        WHERE user_id = ${input.userId}
          AND (
            (status = 'pending' AND created_at > now() - (${this.staleMinutes} * interval '1 minute'))
            OR (status = 'processing' AND started_at > now() - (${this.staleMinutes} * interval '1 minute'))
          )
      ) < ${maxActive}
      RETURNING id
    `);
    // postgres-js returns an array-like of result rows.
    return Array.from(rows as Iterable<{ id: string }>).length > 0;
  }

  async get(
    jobId: string,
    opts?: { userId?: number; orgId?: number },
  ): Promise<JobRow | null> {
    const rows = await this.db
      .select()
      .from(ingestionJobs)
      .where(eq(ingestionJobs.id, jobId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    // Ownership + tenancy checks. Both return null (not 403) so a cross-user or
    // cross-org probe can't distinguish "exists" from "not found".
    if (opts?.userId !== undefined && row.userId !== opts.userId) return null;
    if (opts?.orgId !== undefined && row.orgId !== opts.orgId) return null;
    return rowToJob(row);
  }

  async updateStatus(
    jobId: string,
    status: IngestionJobStatus,
    opts: UpdateStatusOptions = {},
  ): Promise<void> {
    const now = new Date();
    const values: Record<string, unknown> = { status };

    // Match Python's transition rules:
    //  - first move to processing stamps started_at
    //  - any terminal state stamps completed_at and clears current_stage
    if (status === 'processing') {
      values.startedAt = now;
    }
    if (status === 'completed' || status === 'failed' || status === 'partial') {
      values.completedAt = now;
      values.currentStage = null;
    }
    if (opts.result !== undefined) values.result = opts.result;
    if (opts.error !== undefined) values.errorMessage = opts.error;
    if (opts.stage !== undefined) values.currentStage = opts.stage;

    await this.db
      .update(ingestionJobs)
      .set(values)
      .where(eq(ingestionJobs.id, jobId));
  }

  async countActive(userId: number): Promise<number> {
    const rows = await this.db
      .select({ c: count() })
      .from(ingestionJobs)
      .where(and(eq(ingestionJobs.userId, userId), activeWithinWindow(this.staleMinutes)));
    return rows[0]?.c ?? 0;
  }

  async isCancelled(jobId: string): Promise<boolean> {
    const rows = await this.db
      .select({ status: ingestionJobs.status })
      .from(ingestionJobs)
      .where(eq(ingestionJobs.id, jobId))
      .limit(1);
    return rows[0]?.status === 'cancelled';
  }

  async cancelJobsForSpace(spaceId: number): Promise<number> {
    return this.cancelWhere(
      and(
        eq(ingestionJobs.spaceId, spaceId),
        inArray(ingestionJobs.status, ACTIVE_STATUSES),
      ),
      'Job cancelled: space deleted',
    );
  }

  async cancelJobsForOrg(orgId: number): Promise<number> {
    return this.cancelWhere(
      and(
        eq(ingestionJobs.orgId, orgId),
        inArray(ingestionJobs.status, ACTIVE_STATUSES),
      ),
      'Job cancelled: organization deleted',
    );
  }

  private async cancelWhere(
    where: ReturnType<typeof and>,
    reason: string,
  ): Promise<number> {
    const rows = await this.db
      .update(ingestionJobs)
      .set({
        status: 'cancelled',
        completedAt: new Date(),
        errorMessage: reason,
        currentStage: null,
      })
      .where(where)
      .returning({ id: ingestionJobs.id });
    return rows.length;
  }
}

/**
 * Count of in-flight (non-stale pending + processing) jobs across the whole
 * platform — the admission signal for the global queue-depth gate. The
 * staleness window (issue #3) excludes a crashed worker's dead rows so the gate
 * reflects real in-flight work, not graveyard rows.
 */
export async function countActiveIngestionJobs(
  db: Database,
  staleMinutes: number = STALE_JOB_MINUTES,
): Promise<number> {
  const rows = await db
    .select({ c: count() })
    .from(ingestionJobs)
    .where(activeWithinWindow(staleMinutes));
  return rows[0]?.c ?? 0;
}

/**
 * Reaper (issue #3): flip jobs that have exceeded the staleness window with no
 * progress to `failed`, so they (a) stop counting against the gates — the
 * windowed counts already exclude them, this makes it durable — and (b) become
 * terminal, so the daily maintenance cleanup can delete them and `GET /jobs/:id`
 * reflects reality instead of a perpetual `processing`.
 *
 * Guarded on the same staleness predicate the lease/claim uses, so it cannot
 * clobber a job another trigger just re-claimed (that bumps `started_at` fresh)
 * — the CAS simply won't match it. The sources owned by a reaped job are
 * recovered independently by the re-drive sweep, which mints a FRESH job for
 * them; this only retires the dead bookkeeping row.
 *
 * Returns the number of jobs reaped.
 */
export async function reapStaleIngestionJobs(
  db: Database,
  staleMinutes: number = STALE_JOB_MINUTES,
): Promise<number> {
  const cutoff = staleCutoff(staleMinutes);
  const rows = await db
    .update(ingestionJobs)
    .set({
      status: 'failed',
      completedAt: new Date(),
      currentStage: null,
      errorMessage: 'Reaped: no progress within staleness window (orphaned worker)',
    })
    .where(
      or(
        and(eq(ingestionJobs.status, 'processing'), lt(ingestionJobs.startedAt, cutoff)),
        and(eq(ingestionJobs.status, 'pending'), lt(ingestionJobs.createdAt, cutoff)),
      ),
    )
    .returning({ id: ingestionJobs.id });
  return rows.length;
}

function rowToJob(row: typeof ingestionJobs.$inferSelect): JobRow {
  return {
    jobId: row.id,
    orgId: row.orgId,
    spaceId: row.spaceId,
    userId: row.userId,
    status: row.status,
    sourceIds: row.sourceIds as number[],
    result: (row.result as IngestionJobResult | null) ?? null,
    errorMessage: row.errorMessage,
    currentStage: row.currentStage,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

// `sql` re-export kept for future use of raw SQL fragments if needed.
export { sql };
