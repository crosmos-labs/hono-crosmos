import {
  boolean,
  index,
  pgTable,
  serial,
  timestamp,
  uniqueIndex,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { generateUuidV7 } from './_shared.js';

export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    uuid: uuid('uuid').notNull().unique().$defaultFn(generateUuidV7),
    email: varchar('email', { length: 255 }).notNull().unique(),
    name: varchar('name', { length: 255 }).notNull(),
    oauthProvider: varchar('oauth_provider', { length: 50 }),
    oauthProviderId: varchar('oauth_provider_id', { length: 255 }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_idx').on(t.email),
    index('users_created_at_idx').on(t.createdAt),
    index('users_oauth_lookup_idx').on(t.oauthProvider, t.oauthProviderId),
    unique('uq_users_oauth_identity').on(t.oauthProvider, t.oauthProviderId),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
