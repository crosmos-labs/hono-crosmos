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
  vector,
} from 'drizzle-orm/pg-core';
import { generateUuidV7 } from './_shared';
import { memorySpaces } from './memory-spaces';
import { organizations } from './organizations';

/**
 * Graph nodes — proper nouns extracted alongside memories. Deduplicated per
 * `(space_id, lower(name))` via a case-insensitive unique index: two spaces
 * can each have an entity called "User", but within a space the name must
 * be unique. `entity_type` is free-form text (not an enum) so newer types
 * can land without a migration.
 *
 * See .codex/code-architecture.md.
 */
export const entities = pgTable(
  'entities',
  {
    id: serial('id').primaryKey(),
    uuid: uuid('uuid').notNull().unique().$defaultFn(generateUuidV7),
    orgId: integer('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    spaceId: integer('space_id')
      .notNull()
      .references(() => memorySpaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    entityType: text('entity_type'),
    embedding: vector('embedding', { dimensions: 1024 }),
    meta: jsonb('meta'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Concurrency-safe dedup target for `INSERT ... ON CONFLICT DO NOTHING`.
    uniqueIndex('uq_entity_space_name').on(t.spaceId, sql`lower(${t.name})`),
    index('entities_name_idx').on(t.name),
    index('entities_type_idx').on(t.entityType),
    index('entities_space_id_idx').on(t.spaceId),
    index('entities_org_id_idx').on(t.orgId),
    index('idx_entities_org_space').on(t.orgId, t.spaceId),
    index('entities_embedding_hnsw_idx').using(
      'hnsw',
      t.embedding.op('vector_cosine_ops'),
    ),
    index('entities_name_gin_idx').using(
      'gin',
      sql`to_tsvector('english', ${t.name})`,
    ),
  ],
);

export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;
