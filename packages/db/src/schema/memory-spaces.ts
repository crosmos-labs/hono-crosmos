import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { generateUuidV7 } from './_shared';
import { users } from './users';

export const memorySpaces = pgTable(
  'memory_spaces',
  {
    id: serial('id').primaryKey(),
    uuid: uuid('uuid').notNull().unique().$defaultFn(generateUuidV7),
    orgId: integer('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    description: text('description'),
    meta: jsonb('meta'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * Tombstone for deferred deletion. `DELETE /spaces/{uuid}` sets this and
     * returns immediately; physical removal happens later in the maintenance
     * sweep.
     *
     * Immediate hard deletion raced in-flight ingestion (the cascade could
     * remove rows a running job was still writing) and best-effort usage
     * writes, and made a failed external-vector purge unrecoverable — the
     * authoritative memory/entity ids were already gone, so nothing could
     * retry. A tombstone keeps those ids reachable until the vectors are
     * confirmed purged.
     *
     * Every normal read path MUST exclude tombstoned spaces (`activeSpace()`),
     * so a deleted space behaves as absent the moment this is set.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('memory_spaces_name_idx').on(t.name),
    index('memory_spaces_user_id_idx').on(t.userId),
    index('memory_spaces_org_id_idx').on(t.orgId),
    index('memory_spaces_created_at_idx').on(t.createdAt),
    // Pending-deletion lookup for the finalizer. Partial, so it indexes only
    // tombstones rather than every space.
    index('memory_spaces_deleted_at_idx')
      .on(t.deletedAt)
      .where(sql`deleted_at IS NOT NULL`),
    // Name uniqueness applies to ACTIVE spaces only. A plain unique constraint
    // would keep a deleted space's name reserved until the finalizer ran, so a
    // user could not immediately recreate a space they just deleted — a
    // surprising, self-inflicted failure. Partial unique index instead.
    uniqueIndex('uq_memory_spaces_active_org_id_name')
      .on(t.orgId, t.name)
      .where(sql`deleted_at IS NULL`),
  ],
);

export type MemorySpace = typeof memorySpaces.$inferSelect;
export type NewMemorySpace = typeof memorySpaces.$inferInsert;
