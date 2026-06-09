import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { generateUuidV7 } from './_shared';
import { organizations } from './organizations';

export const billingEvents = pgTable(
  'billing_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    uuid: uuid('uuid').notNull().unique().$defaultFn(generateUuidV7),
    polarEventId: varchar('polar_event_id', { length: 64 }).notNull(),
    orgId: integer('org_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),
    eventType: varchar('event_type', { length: 64 }).notNull(),
    payload: jsonb('payload').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [
    uniqueIndex('billing_events_polar_event_id_idx').on(t.polarEventId),
    index('billing_events_org_id_idx').on(t.orgId),
    index('billing_events_event_type_idx').on(t.eventType),
    index('billing_events_unprocessed_idx').on(t.processedAt),
  ],
);

export type BillingEvent = typeof billingEvents.$inferSelect;
export type NewBillingEvent = typeof billingEvents.$inferInsert;
