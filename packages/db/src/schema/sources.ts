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
import { memoryVisibility, sourceExtractionStatus } from './enums';
import { memorySpaces } from './memory-spaces';
import { organizations } from './organizations';
import { users } from './users';

/**
 * Unified raw-content storage. A source is whatever was ingested verbatim
 * (text blob, markdown chunk, transcript turn). Memories are extracted
 * **from** sources; this table is the citation trail.
 *
 * See .codex/code-architecture.md.
 */
export const sources = pgTable(
  'sources',
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
    // Free-form text rather than an enum: today only `text` + `markdown` are
    // processable but the schema admits future binary types stored verbatim.
    contentType: varchar('content_type', { length: 20 }).notNull().default('text'),
    content: text('content').notNull(),
    extractionStatus: sourceExtractionStatus('extraction_status')
      .notNull()
      .default('pending'),
    // session_id, document_id, role, lookback_context, date — see schema doc.
    meta: jsonb('meta'),
    tokenCount: integer('token_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('sources_space_id_idx').on(t.spaceId),
    index('sources_org_id_idx').on(t.orgId),
    index('sources_content_type_idx').on(t.contentType),
    index('sources_extraction_status_idx').on(t.extractionStatus),
    index('sources_created_at_idx').on(t.createdAt),
    index('idx_sources_org_space').on(t.orgId, t.spaceId),
    index('idx_sources_org_owner').on(t.orgId, t.ownerUserId),
  ],
);

export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
