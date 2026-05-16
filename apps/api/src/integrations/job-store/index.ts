import type { Database } from '@crosmos/db';
import { PgJobStore } from './pg';
import type { JobStore } from './port';

export type { JobRow, JobStore, UpdateStatusOptions } from './port';
export { countActiveIngestionJobs } from './pg';

/**
 * Returns the configured job store. Today there's only the Postgres adapter
 * — `db` comes from the per-request `getDb(c)` helper. If we ever want a
 * mock store for tests, drop it in `./noop.ts` and branch here.
 */
export function getJobStore(db: Database): JobStore {
  return new PgJobStore(db);
}
