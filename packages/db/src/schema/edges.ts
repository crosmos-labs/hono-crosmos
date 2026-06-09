import { sql } from 'drizzle-orm';
import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { generateUuidV7 } from './_shared';
import { entities } from './entities';
import { memoryVisibility } from './enums';
import { memories } from './memories';
import { memorySpaces } from './memory-spaces';
import { organizations } from './organizations';
import { users } from './users';

/**
 * ERE relations between two entities, witnessed by one memory. The graph is
 * **monotonic / append-only** — the same triple can be asserted multiple
 * times with different `valid_from` / `confidence` / `memory_id`. Retrieval
 * picks the latest version via `DISTINCT ON (... ) ORDER BY
 * COALESCE(valid_from, recorded_at) DESC`. Ingestion dedupes within a
 * single run (`seen_edge_keys`), not across runs.
 *
 * `memory_id` is `ON DELETE SET NULL`: losing the evidence memory must not
 * drop the edge from the graph.
 *
 * See .codex/code-architecture.md.
 */
export const edges = pgTable(
  'edges',
  {
    id: serial('id').primaryKey(),
    uuid: uuid('uuid').notNull().unique().$defaultFn(generateUuidV7),
    orgId: integer('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    spaceId: integer('space_id')
      .notNull()
      .references(() => memorySpaces.id, { onDelete: 'cascade' }),
    ownerUserId: integer('owner_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    visibility: memoryVisibility('visibility').notNull().default('private'),
    sourceEntityId: integer('source_entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    targetEntityId: integer('target_entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    relationType: varchar('relation_type', { length: 100 }).notNull(),
    memoryId: integer('memory_id').references(() => memories.id, {
      onDelete: 'set null',
    }),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    confidence: doublePrecision('confidence').default(1.0),
    meta: jsonb('meta').default(sql`'{}'::jsonb`),
    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    forgottenAt: timestamp('forgotten_at', { withTimezone: true }),
  },
  (t) => [
    index('edges_source_entity_id_idx').on(t.sourceEntityId),
    index('edges_target_entity_id_idx').on(t.targetEntityId),
    index('edges_relation_type_idx').on(t.relationType),
    index('edges_memory_id_idx').on(t.memoryId),
    index('edges_valid_from_idx').on(t.validFrom),
    index('edges_space_id_idx').on(t.spaceId),
    index('edges_org_id_idx').on(t.orgId),
    index('idx_edges_org_space').on(t.orgId, t.spaceId),
    index('idx_edges_org_owner').on(t.orgId, t.ownerUserId),
    index('edges_space_source_idx').on(t.spaceId, t.sourceEntityId),
    index('edges_space_target_idx').on(t.spaceId, t.targetEntityId),
    // Partial: the only edges retrieval cares about.
    index('edges_not_forgotten_idx')
      .on(t.spaceId)
      .where(sql`forgotten_at IS NULL`),
  ],
);

export type Edge = typeof edges.$inferSelect;
export type NewEdge = typeof edges.$inferInsert;
