import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { ingestionJobStatus } from './enums';
import { memorySpaces } from './memory-spaces';
import { organizations } from './organizations';
import { users } from './users';

/**
 * Lifecycle of one async ingest batch. `id` is `uuid4` (not uuidv7) — matches
 * Python's `uuid.uuid4()` for parity; every other UUID column in this
 * codebase is uuidv7.
 *
 * `source_ids` is a jsonb int[] so the worker can replay the per-source
 * loop without re-querying. `result` is filled in at the terminal
 * transition; see database-schema.md §ingestion_jobs for shape.
 */
export const ingestionJobs = pgTable(
  'ingestion_jobs',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    orgId: integer('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    spaceId: integer('space_id')
      .notNull()
      .references(() => memorySpaces.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: ingestionJobStatus('status').notNull().default('pending'),
    sourceIds: jsonb('source_ids').notNull(),
    result: jsonb('result'),
    errorMessage: text('error_message'),
    currentStage: varchar('current_stage', { length: 50 }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index('ingestion_jobs_user_id_idx').on(t.userId),
    index('ingestion_jobs_space_id_idx').on(t.spaceId),
    index('ingestion_jobs_org_id_idx').on(t.orgId),
    index('ingestion_jobs_status_idx').on(t.status),
    index('ingestion_jobs_created_at_idx').on(t.createdAt),
  ],
);

export type IngestionJob = typeof ingestionJobs.$inferSelect;
export type NewIngestionJob = typeof ingestionJobs.$inferInsert;
