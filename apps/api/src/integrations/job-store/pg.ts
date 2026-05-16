import { ingestionJobs, type Database } from '@crosmos/db';
import type { IngestionJobResult, IngestionJobStatus } from '@crosmos/types';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import type { JobRow, JobStore, UpdateStatusOptions } from './port';

const ACTIVE_STATUSES: IngestionJobStatus[] = ['pending', 'processing'];

/**
 * Postgres-backed `JobStore`. Same DB as everything else — no separate store
 * to provision. Mirrors Python's `PgJobStore`.
 */
export class PgJobStore implements JobStore {
  constructor(private readonly db: Database) {}

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

  async get(jobId: string, opts?: { userId?: number }): Promise<JobRow | null> {
    const rows = await this.db
      .select()
      .from(ingestionJobs)
      .where(eq(ingestionJobs.id, jobId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (opts?.userId !== undefined && row.userId !== opts.userId) return null;
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
      .where(
        and(
          eq(ingestionJobs.userId, userId),
          inArray(ingestionJobs.status, ACTIVE_STATUSES),
        ),
      );
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

/** Returns count of pending + processing jobs across the whole platform. Used by the queue depth check. */
export async function countActiveIngestionJobs(db: Database): Promise<number> {
  const rows = await db
    .select({ c: count() })
    .from(ingestionJobs)
    .where(inArray(ingestionJobs.status, ACTIVE_STATUSES));
  return rows[0]?.c ?? 0;
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
