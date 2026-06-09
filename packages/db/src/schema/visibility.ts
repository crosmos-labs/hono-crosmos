import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  serial,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { generateUuidV7 } from './_shared';
import { organizations } from './organizations';
import { users } from './users';

export const visibilityGroups = pgTable(
  'visibility_groups',
  {
    id: serial('id').primaryKey(),
    uuid: uuid('uuid').notNull().unique().$defaultFn(generateUuidV7),
    orgId: integer('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 64 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    createdByUserId: integer('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('uq_visibility_groups_org_slug').on(t.orgId, t.slug),
    index('visibility_groups_org_id_idx').on(t.orgId),
  ],
);

export const visibilityGroupMembers = pgTable(
  'visibility_group_members',
  {
    id: serial('id').primaryKey(),
    uuid: uuid('uuid').notNull().unique().$defaultFn(generateUuidV7),
    orgId: integer('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    groupId: integer('group_id')
      .notNull()
      .references(() => visibilityGroups.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('uq_visibility_group_members').on(t.groupId, t.userId),
    index('visibility_group_members_org_user_idx').on(t.orgId, t.userId),
    index('visibility_group_members_group_id_idx').on(t.groupId),
  ],
);

export const visibilityGrants = pgTable(
  'visibility_grants',
  {
    id: serial('id').primaryKey(),
    uuid: uuid('uuid').notNull().unique().$defaultFn(generateUuidV7),
    orgId: integer('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    viewerGroupId: integer('viewer_group_id')
      .notNull()
      .references(() => visibilityGroups.id, { onDelete: 'cascade' }),
    subjectGroupId: integer('subject_group_id')
      .notNull()
      .references(() => visibilityGroups.id, { onDelete: 'cascade' }),
    createdByUserId: integer('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('uq_visibility_grants_edge').on(
      t.orgId,
      t.viewerGroupId,
      t.subjectGroupId,
    ),
    check('ck_visibility_grants_no_self', sql`${t.viewerGroupId} <> ${t.subjectGroupId}`),
    index('visibility_grants_org_id_idx').on(t.orgId),
    index('visibility_grants_viewer_group_idx').on(t.viewerGroupId),
  ],
);

export type VisibilityGroup = typeof visibilityGroups.$inferSelect;
export type NewVisibilityGroup = typeof visibilityGroups.$inferInsert;
export type VisibilityGroupMember = typeof visibilityGroupMembers.$inferSelect;
export type NewVisibilityGroupMember = typeof visibilityGroupMembers.$inferInsert;
export type VisibilityGrant = typeof visibilityGrants.$inferSelect;
export type NewVisibilityGrant = typeof visibilityGrants.$inferInsert;
