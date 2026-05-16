import { sql } from 'drizzle-orm';
import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { generateUuidV7 } from './_shared';
import { memoryType } from './enums';
import { memorySpaces } from './memory-spaces';
import { organizations } from './organizations';

/**
 * Atomic facts extracted from sources. Embedding-bearing. Soft-deleted via
 * `forgotten_at` — ingestion never physically deletes. The embedding column
 * is `vector(1536)` to match OpenAI `text-embedding-3-small`; changing the
 * embedding model means a schema change here.
 *
 * See docs/ingestion_migration/database-schema.md §memories.
 */
export const memories = pgTable(
  'memories',
  {
    id: serial('id').primaryKey(),
    uuid: uuid('uuid').notNull().unique().$defaultFn(generateUuidV7),
    orgId: integer('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    spaceId: integer('space_id')
      .notNull()
      .references(() => memorySpaces.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    memoryType: memoryType('memory_type').notNull(),
    embedding: vector('embedding', { dimensions: 1536 }),
    importanceScore: doublePrecision('importance_score'),
    meta: jsonb('meta'),
    eventTime: timestamp('event_time', { withTimezone: true }),
    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    accessFrequency: integer('access_frequency').notNull().default(0),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    forgottenAt: timestamp('forgotten_at', { withTimezone: true }),
    // Clustering columns — written by the inference pass, not ingestion.
    inferredIds: integer('inferred_ids').array(),
    stabilityScore: integer('stability_score'),
    inferredAt: timestamp('inferred_at', { withTimezone: true }),
    clusteredAt: timestamp('clustered_at', { withTimezone: true }),
  },
  (t) => [
    index('memories_memory_type_idx').on(t.memoryType),
    index('memories_created_at_idx').on(t.createdAt),
    index('memories_space_id_idx').on(t.spaceId),
    index('memories_org_id_idx').on(t.orgId),
    index('memories_event_time_idx').on(t.eventTime),
    index('memories_importance_idx').on(t.importanceScore),
    index('idx_memories_org_space').on(t.orgId, t.spaceId),
    index('memories_embedding_hnsw_idx').using(
      'hnsw',
      t.embedding.op('vector_cosine_ops'),
    ),
    // Partial: active (non-forgotten) memories within a space — the hot path.
    index('active_memories_space_idx')
      .on(t.spaceId)
      .where(sql`forgotten_at IS NULL`),
    index('memories_content_search_gin_idx').using(
      'gin',
      sql`to_tsvector('english', ${t.content})`,
    ),
    index('memories_inferred_ids_gin_idx').using('gin', t.inferredIds),
  ],
);

export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;
