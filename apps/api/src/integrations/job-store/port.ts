import type { IngestionJobResult, IngestionJobStatus } from '@crosmos/types';

/**
 * JobStore — persistence layer for ingestion job lifecycle.
 *
 * Implementations: see `./pg.ts` (Postgres via Drizzle). Routes get one via
 * `getJobStore(env, db)` in `./index.ts`. Both the API worker (producer:
 * `create`, `get`, `countActive`) and the ingestion worker (consumer:
 * `updateStatus`, `isCancelled`) eventually depend on this port — keep the
 * surface small so swapping backends stays cheap.
 *
 * Mirrors Python's `app/worker/ports.py:JobStore`.
 */
export interface JobRow {
  jobId: string;
  orgId: number;
  spaceId: number;
  userId: number;
  status: IngestionJobStatus;
  sourceIds: number[];
  result: IngestionJobResult | null;
  errorMessage: string | null;
  currentStage: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface UpdateStatusOptions {
  result?: IngestionJobResult;
  error?: string;
  stage?: string;
}

export interface JobStore {
  create(input: {
    jobId: string;
    orgId: number;
    spaceId: number;
    userId: number;
    sourceIds: number[];
  }): Promise<void>;

  /**
   * Fetch by id. If `userId` is provided, enforces ownership — returns `null`
   * for cross-user reads (matches Python so `GET /jobs/{job_id}` 404s instead
   * of 403, avoiding existence leaks).
   */
  get(jobId: string, opts?: { userId?: number }): Promise<JobRow | null>;

  updateStatus(
    jobId: string,
    status: IngestionJobStatus,
    opts?: UpdateStatusOptions,
  ): Promise<void>;

  /** Count of `pending`+`processing` jobs for one user — for per-user cap. */
  countActive(userId: number): Promise<number>;

  isCancelled(jobId: string): Promise<boolean>;

  /** Mark all pending/processing jobs for a space as cancelled. Returns count. */
  cancelJobsForSpace(spaceId: number): Promise<number>;

  /** Same as above for a whole org. Called during org deletion. */
  cancelJobsForOrg(orgId: number): Promise<number>;
}
