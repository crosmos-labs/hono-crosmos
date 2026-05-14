import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { orgRoleType, planType, subscriptionStatusType } from './enums.js';
import { generateUuidV7 } from './_shared.js';
import { users } from './users.js';

export const organizations = pgTable(
  'organizations',
  {
    id: serial('id').primaryKey(),
    uuid: uuid('uuid').notNull().unique().$defaultFn(generateUuidV7),
    slug: varchar('slug', { length: 64 }).notNull().unique(),
    name: varchar('name', { length: 255 }).notNull(),
    plan: planType('plan').notNull().default('free'),
    isPersonal: boolean('is_personal').notNull().default(false),
    entitlements: jsonb('entitlements'),
    posthogFlagOverrides: jsonb('posthog_flag_overrides'),
    billingEmail: varchar('billing_email', { length: 255 }),
    polarCustomerId: varchar('polar_customer_id', { length: 64 }).unique(),
    polarSubscriptionId: varchar('polar_subscription_id', { length: 64 }),
    subscriptionStatus: subscriptionStatusType('subscription_status')
      .notNull()
      .default('none'),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    planPending: varchar('plan_pending', { length: 32 }),
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
    uniqueIndex('organizations_slug_idx').on(t.slug),
    index('organizations_plan_idx').on(t.plan),
    index('organizations_created_at_idx').on(t.createdAt),
  ],
);

export const organizationMembers = pgTable(
  'organization_members',
  {
    id: serial('id').primaryKey(),
    uuid: uuid('uuid').notNull().unique().$defaultFn(generateUuidV7),
    orgId: integer('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: orgRoleType('role').notNull(),
    invitedByUserId: integer('invited_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    joinedAt: timestamp('joined_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('org_members_user_id_idx').on(t.userId),
    index('org_members_org_role_idx').on(t.orgId, t.role),
    unique('uq_org_members_org_user').on(t.orgId, t.userId),
  ],
);

export const organizationInvites = pgTable(
  'organization_invites',
  {
    id: serial('id').primaryKey(),
    uuid: uuid('uuid').notNull().unique().$defaultFn(generateUuidV7),
    orgId: integer('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 255 }).notNull(),
    role: orgRoleType('role').notNull().default('member'),
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
    invitedBy: integer('invited_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '7 days'`),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('org_invites_org_id_idx').on(t.orgId),
    uniqueIndex('org_invites_token_hash_idx').on(t.tokenHash),
    uniqueIndex('uq_org_invites_pending')
      .on(t.orgId, t.email)
      .where(sql`accepted_at IS NULL`),
  ],
);

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type OrganizationMember = typeof organizationMembers.$inferSelect;
export type NewOrganizationMember = typeof organizationMembers.$inferInsert;
export type OrganizationInvite = typeof organizationInvites.$inferSelect;
export type NewOrganizationInvite = typeof organizationInvites.$inferInsert;
