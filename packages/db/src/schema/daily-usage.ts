import {
  date,
  index,
  integer,
  pgTable,
  serial,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { generateUuidV7 } from './_shared';
import { memorySpaces } from './memory-spaces';
import { organizations } from './organizations';
import { users } from './users';

/**
 * Per-org, per-user, per-space, per-day counters. Atomically upserted via
 * `INSERT ... ON CONFLICT (uq_daily_usage_org_space_date) DO UPDATE` —
 * ingestion writes `tokens_ingested`, retrieval writes `search_queries`.
 *
 * The unique constraint is keyed on (org, user, space, date) so two users
 * in the same space on the same day get separate rows — usage is attributed
 * to the user, but quotas/billing read at the org level.
 */
export const dailyUsage = pgTable(
  'daily_usage',
  {
    id: serial('id').primaryKey(),
    uuid: uuid('uuid').notNull().unique().$defaultFn(generateUuidV7),
    orgId: integer('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * Historical dimension only — deliberately NOT a foreign key.
     *
     * With the FK's ON DELETE CASCADE, deleting a space silently erased its
     * billing history, so an org's recorded usage could go DOWN. Worse, the
     * cascade raced best-effort usage writes: a search or ingestion settling
     * just after a delete could fail its usage write, or write a row that was
     * immediately removed.
     *
     * The column stays NOT NULL and keeps its uniqueness key; the org and user
     * foreign keys are unchanged. Retention is the 400-day cleanup sweep, not
     * referential integrity. Consequence to remember: a space id here may no
     * longer resolve to a `memory_spaces` row, so joins must be outer.
     */
    spaceId: integer('space_id').notNull(),
    date: date('date').notNull(),
    tokensIngested: integer('tokens_ingested').notNull().default(0),
    searchQueries: integer('search_queries').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('uq_daily_usage_org_space_date').on(
      t.orgId,
      t.userId,
      t.spaceId,
      t.date,
    ),
    index('daily_usage_user_id_idx').on(t.userId),
    index('daily_usage_org_id_idx').on(t.orgId),
    index('daily_usage_user_date_idx').on(t.userId, t.date),
  ],
);

export type DailyUsage = typeof dailyUsage.$inferSelect;
export type NewDailyUsage = typeof dailyUsage.$inferInsert;
