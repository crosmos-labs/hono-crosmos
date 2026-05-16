import { pgEnum } from 'drizzle-orm/pg-core';

export const planType = pgEnum('plan_type', [
  'free',
  'developer',
  'pro',
  'enterprise',
]);

export const orgRoleType = pgEnum('org_role_type', ['owner', 'admin', 'member']);

export const subscriptionStatusType = pgEnum('subscription_status_type', [
  'none',
  'active',
  'past_due',
  'canceled',
  'revoked',
]);

export const memoryType = pgEnum('memory_type', [
  'viewpoint',
  'semantic',
  'episode',
  'inference',
]);

export const sourceExtractionStatus = pgEnum('source_extraction_status', [
  'pending',
  'processing',
  'completed',
  'failed',
]);

export const ingestionJobStatus = pgEnum('ingestion_job_status', [
  'pending',
  'processing',
  'completed',
  'partial',
  'failed',
  'cancelled',
]);
