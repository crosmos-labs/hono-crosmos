import {
  index,
  integer,
  pgTable,
  serial,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { chunks } from './chunks';
import { entities } from './entities';
import { memories } from './memories';

/**
 * Junction tables for chunk→memory and memory→entity edges.
 *
 * These carry no `org_id` / `space_id`. Isolation is transitive: every parent
 * row is already scoped, and FK CASCADE wipes the junction with the parent.
 * The pipeline must never insert a row where the two parents come from
 * different `(org_id, space_id)` pairs — `resolve_entities` enforces this
 * by being called with the same scope used to insert the memory.
 */
export const chunkMemories = pgTable(
  'chunk_memories',
  {
    id: serial('id').primaryKey(),
    chunkId: integer('chunk_id')
      .notNull()
      .references(() => chunks.id, { onDelete: 'cascade' }),
    memoryId: integer('memory_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),
    extractionTimestamp: timestamp('extraction_timestamp', {
      withTimezone: true,
    }),
  },
  (t) => [
    unique('uq_chunk_memory').on(t.chunkId, t.memoryId),
    index('chunk_memories_chunk_id_idx').on(t.chunkId),
    index('chunk_memories_memory_id_idx').on(t.memoryId),
  ],
);

export const memoryEntities = pgTable(
  'memory_entities',
  {
    id: serial('id').primaryKey(),
    memoryId: integer('memory_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),
    entityId: integer('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
  },
  (t) => [
    unique('uq_memory_entities').on(t.memoryId, t.entityId),
    index('memory_entities_memory_id_idx').on(t.memoryId),
    index('memory_entities_entity_id_idx').on(t.entityId),
  ],
);

export type ChunkMemory = typeof chunkMemories.$inferSelect;
export type NewChunkMemory = typeof chunkMemories.$inferInsert;
export type MemoryEntity = typeof memoryEntities.$inferSelect;
export type NewMemoryEntity = typeof memoryEntities.$inferInsert;
