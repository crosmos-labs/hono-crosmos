import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
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
  },
  (t) => [
    index('memory_spaces_name_idx').on(t.name),
    index('memory_spaces_user_id_idx').on(t.userId),
    index('memory_spaces_org_id_idx').on(t.orgId),
    index('memory_spaces_created_at_idx').on(t.createdAt),
    unique('uq_memory_spaces_org_id_name').on(t.orgId, t.name),
  ],
);

export type MemorySpace = typeof memorySpaces.$inferSelect;
export type NewMemorySpace = typeof memorySpaces.$inferInsert;
