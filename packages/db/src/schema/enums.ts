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
