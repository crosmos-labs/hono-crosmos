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

export const PaymentStatusSchema = z.enum([
  'draft',
  'pending',
  'paid',
  'refunded',
  'partially_refunded',
  'void',
]);

export const PaymentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1).openapi({ example: 1 }),
  limit: z.coerce.number().int().min(1).max(100).default(20).openapi({ example: 20 }),
});

export const PaymentSchema = z
  .object({
    id: z.string(),
    status: PaymentStatusSchema,
    paid: z.boolean(),
    created_at: IsoDateTimeSchema,
    // All amounts are minor units (cents) of `currency`, matching Polar.
    subtotal_amount: z.number().int(),
    discount_amount: z.number().int(),
    tax_amount: z.number().int(),
    total_amount: z.number().int(),
    refunded_amount: z.number().int(),
    currency: z.string(),
    billing_reason: z.string(),
    description: z.string().nullable(),
    invoice_number: z.string().nullable(),
    // False when Polar has not generated the PDF yet; the invoice route will
    // trigger generation on demand rather than 404.
    invoice_available: z.boolean(),
    product_name: z.string().nullable(),
    plan: PlanSchema.nullable(),
  })
  .openapi('Payment');

export const PaymentsResponseSchema = z
  .object({
    payments: z.array(PaymentSchema),
    pagination: z.object({
      page: z.number().int(),
      limit: z.number().int(),
      total_count: z.number().int(),
      max_page: z.number().int(),
    }),
  })
  .openapi('PaymentsResponse');

export const InvoiceResponseSchema = z
  .object({ invoice_url: z.string().url() })
  .openapi('InvoiceResponse');
