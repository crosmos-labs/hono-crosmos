import { z } from '@hono/zod-openapi';
import { IsoDateTimeSchema, PlanSchema } from '../../lib/zod-common';

export const PurchasablePlanSchema = z.enum(['developer', 'pro']);

export const PlanCatalogItemSchema = z
  .object({
    plan: PlanSchema,
    price_usd: z.number().int(),
    max_memory_spaces: z.number().int(),
    monthly_tokens_ingested: z.number().int(),
    monthly_search_queries: z.number().int(),
    status: z.enum(['live', 'coming_soon']),
  })
  .openapi('PlanCatalogItem');

export const PlanCatalogResponseSchema = z
  .object({ plans: z.array(PlanCatalogItemSchema) })
  .openapi('PlanCatalogResponse');

export const SubscriptionStatusSchema = z.enum([
  'none',
  'active',
  'past_due',
  'canceled',
  'revoked',
]);

export const SubscriptionResponseSchema = z
  .object({
    plan: PlanSchema,
    subscription_status: SubscriptionStatusSchema,
    current_period_end: IsoDateTimeSchema.nullable(),
    plan_pending: z.string().nullable(),
  })
  .openapi('SubscriptionResponse');

export const CreateCheckoutRequestSchema = z
  .object({
    plan: PurchasablePlanSchema.openapi({
      description:
        "Plan to upgrade to. Only 'developer' and 'pro' are purchasable.",
    }),
  })
  .openapi('CreateCheckoutRequest');

export const CreateCheckoutResponseSchema = z
  .object({ checkout_url: z.string().url() })
  .openapi('CreateCheckoutResponse');

export const PortalResponseSchema = z
  .object({ portal_url: z.string().url() })
  .openapi('PortalResponse');

export const CancelResponseSchema = z
  .object({
    cancel_at_period_end: z.literal(true).default(true),
    subscription_status: SubscriptionStatusSchema,
  })
  .openapi('CancelResponse');

export const WebhookAckSchema = z
  .object({ received: z.literal(true) })
  .openapi('WebhookAck');
