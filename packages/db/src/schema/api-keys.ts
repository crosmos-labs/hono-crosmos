import {
  boolean,
  index,
  integer,
  pgTable,
  serial,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { generateUuidV7 } from './_shared';
import { memorySpaces } from './memory-spaces';
import { users } from './users';

export const apiKeys = pgTable(
  'api_keys',
  {
    id: serial('id').primaryKey(),
    uuid: uuid('uuid').notNull().unique().$defaultFn(generateUuidV7),
    orgId: integer('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Optional space scope. NULL (default) = org-wide key (legacy behavior,
    // unchanged). When set, auth pins the request to this space and the
    // data-plane gates (ingest/search/sources) reject any other space — so a
    // scoped key is safe to hand to a single end-user's frontend. CASCADE: if
    // the space is deleted, its scoped keys go with it.
    spaceId: integer('space_id').references(() => memorySpaces.id, {
      onDelete: 'cascade',
    }),
    keyPrefix: varchar('key_prefix', { length: 12 }).notNull(),
    keyHash: varchar('key_hash', { length: 64 }).notNull().unique(),
    name: varchar('name', { length: 255 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('api_keys_user_id_idx').on(t.userId),
    index('api_keys_org_id_idx').on(t.orgId),
    index('api_keys_space_id_idx').on(t.spaceId),
    uniqueIndex('api_keys_key_hash_idx').on(t.keyHash),
    index('api_keys_created_at_idx').on(t.createdAt),
  ],
);

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
