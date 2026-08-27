import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  serial,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { generateUuidV7 } from './_shared';
import { memorySpaces } from './memory-spaces';
import { organizations } from './organizations';
import { users } from './users';

/**
 * Authorization and destination state for an external content connector.
 *
 * `provider` identifies the external system (`notion`, `slack`).
 * `externalAccountId` identifies the real workspace/account in that system.
 * `authBackend` + `authConnectionId` are an opaque credential reference, so
 * Composio can be replaced by internal OAuth without changing connector data.
 */
export const connectorConnections = pgTable(
  'connector_connections',
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
    // Nullable only for the expand/backfill rollout. New connections always
    // set this; after existing rows are backfilled, a generated follow-up
    // migration will make it NOT NULL.
    viewerUserId: integer('viewer_user_id').references(() => users.id, {
      onDelete: 'cascade',
    }),
    provider: varchar('provider', { length: 50 }).notNull(),
    authBackend: varchar('auth_backend', { length: 50 }).notNull(),
    authConnectionId: varchar('auth_connection_id', { length: 255 }).notNull(),
    externalAccountId: varchar('external_account_id', { length: 255 }),
    displayName: varchar('display_name', { length: 255 }),
    status: varchar('status', { length: 30 }).notNull().default('pending'),
    connectedAt: timestamp('connected_at', { withTimezone: true }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('connector_connections_org_id_idx').on(t.orgId),
    index('connector_connections_space_id_idx').on(t.spaceId),
    index('connector_connections_owner_user_id_idx').on(t.ownerUserId),
    index('connector_connections_viewer_user_id_idx').on(t.viewerUserId),
    index('connector_connections_provider_status_idx').on(t.provider, t.status),
    uniqueIndex('uq_connector_auth_connection').on(
      t.authBackend,
      t.authConnectionId,
    ),
    uniqueIndex('uq_connector_viewer_space_external_account')
      .on(t.spaceId, t.viewerUserId, t.provider, t.externalAccountId)
      .where(
        sql`${t.externalAccountId} IS NOT NULL AND ${t.status} IN ('pending', 'active')`,
      ),
    check(
      'ck_connector_connection_status',
      sql`${t.status} IN ('pending', 'active', 'expired', 'failed', 'disabled')`,
    ),
  ],
);

export type ConnectorConnection = typeof connectorConnections.$inferSelect;
export type NewConnectorConnection = typeof connectorConnections.$inferInsert;
