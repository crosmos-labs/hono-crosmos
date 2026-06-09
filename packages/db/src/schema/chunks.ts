import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { generateUuidV7 } from './_shared';
import { memorySpaces } from './memory-spaces';
import { organizations } from './organizations';
import { sources } from './sources';

/**
 * A chunk of source content used as extraction evidence. Legacy short sources
 * produce one chunk; larger or conversation sources can produce many chunks.
 */
export const chunks = pgTable(
  'chunks',
  {
    id: serial('id').primaryKey(),
    uuid: uuid('uuid').notNull().unique().$defaultFn(generateUuidV7),
    orgId: integer('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    spaceId: integer('space_id')
      .notNull()
      .references(() => memorySpaces.id, { onDelete: 'cascade' }),
    sourceId: integer('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull().default(0),
    content: text('content').notNull(),
    tokenCount: integer('token_count').notNull().default(0),
    chunker: varchar('chunker', { length: 32 }).notNull().default('legacy'),
    meta: jsonb('meta'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('chunks_source_id_sequence_idx').on(t.sourceId, t.sequence),
    index('chunks_space_id_idx').on(t.spaceId),
    index('chunks_org_id_idx').on(t.orgId),
    index('chunks_created_at_idx').on(t.createdAt),
    index('idx_chunks_org_space').on(t.orgId, t.spaceId),
  ],
);

export type Chunk = typeof chunks.$inferSelect;
export type NewChunk = typeof chunks.$inferInsert;
