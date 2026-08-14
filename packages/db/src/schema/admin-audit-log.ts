import { index, jsonb, pgTable, serial, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { generateUuidV7 } from './_shared';

/** Append-only admin-plane audit evidence. No update/delete helper is exposed. */
export const adminAuditLog = pgTable('admin_audit_log', {
  id: serial('id').primaryKey(),
  uuid: uuid('uuid').notNull().unique().$defaultFn(generateUuidV7),
  actorEmail: varchar('actor_email', { length: 255 }).notNull(),
  action: varchar('action', { length: 100 }).notNull(),
  targetType: varchar('target_type', { length: 50 }).notNull(),
  targetId: varchar('target_id', { length: 255 }).notNull(),
  before: jsonb('before'),
  after: jsonb('after'),
  requestId: uuid('request_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('admin_audit_log_actor_idx').on(t.actorEmail),
  index('admin_audit_log_target_idx').on(t.targetId),
  index('admin_audit_log_created_at_idx').on(t.createdAt),
]);

export type AdminAuditLog = typeof adminAuditLog.$inferSelect;
