import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { createApiApp } from '../../lib/openapi';
import { createLogger } from '@crosmos/observability';
import { HTTPException } from 'hono/http-exception';
import type { HonoEnv } from '../../bindings';
import { getDb } from '../../db';
import { ErrorResponseSchema } from '../../lib/zod-common';
import { requireAuth } from '../auth/middleware';
import { requireRole } from '../auth/principal';
import { perIpRateLimit } from '../../integrations/rate-limit/ip';
import { getOrganizationByIdOrThrow } from '../orgs/service';
import {
  BillingConfigError,
  cancelSubscription,
  createCheckoutSession,
  createCustomerPortalSession,
  getPaymentInvoice,
  getPlanCatalog,
  listPayments,
  PaymentNotFoundError,
  PolarRequestError,
  subscriptionResponse,
} from './service';
import {
  CancelResponseSchema,
  CreateCheckoutRequestSchema,
  CreateCheckoutResponseSchema,
  InvoiceResponseSchema,
  PaymentsQuerySchema,
  PaymentsResponseSchema,
  PlanCatalogResponseSchema,
  PortalResponseSchema,
  SubscriptionResponseSchema,
  WebhookAckSchema,
} from './schemas';
import { handlePolarWebhook, WebhookHttpError } from './webhooks';

export const billingRoutes = createApiApp();
export const billingWebhookRoutes = createApiApp();

const BillingErrorSchema = z
  .object({ detail: z.string() })
  .openapi('BillingError');

const BILLING_LIMITS = {
  checkout: 5,
  portal: 10,
  cancel: 5,
} as const;

async function enforceBillingRateLimit(
  c: Parameters<typeof getDb>[0],
  action: keyof typeof BILLING_LIMITS,
): Promise<void> {
  const key = `rate:billing:${action}:${c.var.activeOrgId!}`;
  try {
    const current = Number((await c.env.API_KEY_CACHE.get(key)) ?? '0');
    const next = current + 1;
    await c.env.API_KEY_CACHE.put(key, String(next), { expirationTtl: 3600 });
    if (next > BILLING_LIMITS[action]) {
      throw new HTTPException(429, { message: `rate_limited:${action}` });
    }
  } catch (err) {
    if (err instanceof HTTPException) throw err;
    // Fail open on KV errors; billing provider calls remain authoritative.
    createLogger({ service: 'api', environment: c.env.ENVIRONMENT }).warn(
      'rate_limit.kv_failure',
      { stage: 'billing_rate_limit', org_id: c.var.activeOrgId },
      err,
    );
  }
}

type BillingAction = 'checkout' | 'portal' | 'cancel' | 'payments' | 'invoice';

function providerErrorDetail(action: BillingAction) {
  return `${action}_provider_error`;
}

async function mapBillingError<T>(
  action: BillingAction,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BillingConfigError) {
      throw new HTTPException(400, { message: err.message });
    }
    if (err instanceof PaymentNotFoundError) {
      throw new HTTPException(404, { message: err.message });
    }
    if (err instanceof PolarRequestError) {
      throw new HTTPException(502, { message: providerErrorDetail(action) });
    }
    throw err;
  }
}

billingRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/plans',
    tags: ['billing'],
    summary: 'List billing plans',
    responses: {
      200: {
        description: 'Plan catalog',
        content: { 'application/json': { schema: PlanCatalogResponseSchema } },
      },
    },
  }),
  (c) => c.json({ plans: getPlanCatalog() }, 200),
);

billingRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/subscription',
    tags: ['billing'],
    summary: 'Get subscription summary',
    security: [{ bearerAuth: [] }],
    // Read-only, non-sensitive plan summary — visible to any org member.
    // Billing *actions* (checkout/portal/cancel) stay owner-only below.
    middleware: [requireAuth, requireRole('owner', 'admin', 'member')] as const,
    responses: {
      200: {
        description: 'Subscription summary',
        content: { 'application/json': { schema: SubscriptionResponseSchema } },
      },
      401: {
        description: 'Unauthorized',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const org = await getOrganizationByIdOrThrow(getDb(c), c.var.activeOrgId!);
    return c.json(subscriptionResponse(org), 200);
  },
);

billingRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/checkout',
    tags: ['billing'],
    summary: 'Create Polar checkout session',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requireRole('owner')] as const,
    request: {
      body: {
        content: { 'application/json': { schema: CreateCheckoutRequestSchema } },
      },
    },
    responses: {
      201: {
        description: 'Checkout session',
        content: { 'application/json': { schema: CreateCheckoutResponseSchema } },
      },
      400: {
        description: 'Rejected checkout request',
        content: { 'application/json': { schema: BillingErrorSchema } },
      },
      429: {
        description: 'Rate limited',
        content: { 'application/json': { schema: BillingErrorSchema } },
      },
      502: {
        description: 'Provider error',
        content: { 'application/json': { schema: BillingErrorSchema } },
      },
    },
  }),
  async (c) => {
    await enforceBillingRateLimit(c, 'checkout');
    const { plan } = c.req.valid('json');
    const checkoutUrl = await mapBillingError('checkout', () =>
      createCheckoutSession(getDb(c), c.env, {
        orgId: c.var.activeOrgId!,
        plan,
      }),
    );
    return c.json({ checkout_url: checkoutUrl }, 201);
  },
);

billingRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/portal',
    tags: ['billing'],
    summary: 'Create Polar customer portal session',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requireRole('owner')] as const,
    responses: {
      200: {
        description: 'Customer portal URL',
        content: { 'application/json': { schema: PortalResponseSchema } },
      },
      400: {
        description: 'Rejected portal request',
        content: { 'application/json': { schema: BillingErrorSchema } },
      },
      429: {
        description: 'Rate limited',
        content: { 'application/json': { schema: BillingErrorSchema } },
      },
      502: {
        description: 'Provider error',
        content: { 'application/json': { schema: BillingErrorSchema } },
      },
    },
  }),
  async (c) => {
    await enforceBillingRateLimit(c, 'portal');
    const portalUrl = await mapBillingError('portal', () =>
      createCustomerPortalSession(getDb(c), c.env, c.var.activeOrgId!),
    );
    return c.json({ portal_url: portalUrl }, 200);
  },
);

billingRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/cancel',
    tags: ['billing'],
    summary: 'Cancel subscription at period end',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requireRole('owner')] as const,
    responses: {
      200: {
        description: 'Cancellation scheduled',
        content: { 'application/json': { schema: CancelResponseSchema } },
      },
      400: {
        description: 'Rejected cancellation',
        content: { 'application/json': { schema: BillingErrorSchema } },
      },
      429: {
        description: 'Rate limited',
        content: { 'application/json': { schema: BillingErrorSchema } },
      },
      502: {
        description: 'Provider error',
        content: { 'application/json': { schema: BillingErrorSchema } },
      },
    },
  }),
  async (c) => {
    await enforceBillingRateLimit(c, 'cancel');
    await mapBillingError('cancel', () =>
      cancelSubscription(getDb(c), c.env, c.var.activeOrgId!),
    );
    const org = await getOrganizationByIdOrThrow(getDb(c), c.var.activeOrgId!);
    return c.json(
      {
        cancel_at_period_end: true as const,
        subscription_status: org.subscriptionStatus,
      },
      200,
    );
  },
);

// Reads, so they use the DO-backed per-IP limiter rather than the KV counter the
// write actions above use: a dashboard polls this, and a KV put per request would
// walk straight into the free-tier daily put cap.
billingRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/payments',
    tags: ['billing'],
    summary: 'List org payment history',
    description:
      'Paginated Polar order history for the active org, newest first. Amounts are ' +
      'in minor units (cents) of the order currency. An org that has never paid ' +
      'returns an empty list.',
    security: [{ bearerAuth: [] }],
    // Invoices and amounts are financial records: owners and admins, not members.
    middleware: [
      requireAuth,
      requireRole('owner', 'admin'),
      perIpRateLimit({ bucket: 'billing-payments', tier: 'standard' }),
    ] as const,
    request: { query: PaymentsQuerySchema },
    responses: {
      200: {
        description: 'Payment history',
        content: { 'application/json': { schema: PaymentsResponseSchema } },
      },
      401: {
        description: 'Unauthorized',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
      403: {
        description: 'Insufficient role',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
      429: {
        description: 'Rate limited',
        content: { 'application/json': { schema: BillingErrorSchema } },
      },
      502: {
        description: 'Provider error',
        content: { 'application/json': { schema: BillingErrorSchema } },
      },
    },
  }),
  async (c) => {
    const { page, limit } = c.req.valid('query');
    const result = await mapBillingError('payments', () =>
      listPayments(getDb(c), c.env, {
        orgId: c.var.activeOrgId!,
        page,
        limit,
      }),
    );
    return c.json(result, 200);
  },
);

billingRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/payments/{payment_id}/invoice',
    tags: ['billing'],
    summary: 'Get invoice URL for a payment',
    description:
      "Returns a URL to the order's invoice PDF. Polar generates invoices lazily: " +
      'if one does not exist yet this triggers generation and responds 202, and the ' +
      'client should retry shortly.',
    security: [{ bearerAuth: [] }],
    middleware: [
      requireAuth,
      requireRole('owner', 'admin'),
      perIpRateLimit({ bucket: 'billing-invoice', tier: 'standard' }),
    ] as const,
    request: {
      params: z.object({
        payment_id: z.string().uuid().openapi({ param: { name: 'payment_id', in: 'path' } }),
      }),
    },
    responses: {
      200: {
        description: 'Invoice URL',
        content: { 'application/json': { schema: InvoiceResponseSchema } },
      },
      202: {
        description: 'Invoice is being generated; retry shortly',
        content: {
          'application/json': {
            schema: z
              .object({ status: z.literal('generating') })
              .openapi('InvoicePending'),
          },
        },
      },
      401: {
        description: 'Unauthorized',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
      403: {
        description: 'Insufficient role',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
      404: {
        description: 'No such payment for this org',
        content: { 'application/json': { schema: BillingErrorSchema } },
      },
      429: {
        description: 'Rate limited',
        content: { 'application/json': { schema: BillingErrorSchema } },
      },
      502: {
        description: 'Provider error',
        content: { 'application/json': { schema: BillingErrorSchema } },
      },
    },
  }),
  async (c) => {
    const { payment_id } = c.req.valid('param');
    const invoice = await mapBillingError('invoice', () =>
      getPaymentInvoice(getDb(c), c.env, {
        orgId: c.var.activeOrgId!,
        orderId: payment_id,
      }),
    );
    if (invoice.status === 'generating') {
      return c.json({ status: 'generating' as const }, 202);
    }
    return c.json({ invoice_url: invoice.url }, 200);
  },
);

billingWebhookRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/polar',
    tags: ['webhooks'],
    summary: 'Receive Polar webhook',
    // Per-IP throttle in front of the HMAC verify + JSON parse + DB work, so an
    // attacker can't burn CPU/DB by flooding forged payloads (signature failures
    // still cost a hash). Fails open — a degraded limiter must not drop genuine
    // Polar deliveries. Polar's real webhook volume is far under 30/min/IP.
    middleware: [perIpRateLimit({ bucket: 'polar-webhook', tier: 'standard' })] as const,
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.record(z.unknown()).openapi('PolarWebhookPayload'),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Acknowledged',
        content: { 'application/json': { schema: WebhookAckSchema } },
      },
      400: {
        description: 'Bad webhook request',
        content: { 'application/json': { schema: BillingErrorSchema } },
      },
      401: {
        description: 'Invalid signature',
        content: { 'application/json': { schema: BillingErrorSchema } },
      },
      413: {
        description: 'Payload too large',
        content: { 'application/json': { schema: BillingErrorSchema } },
      },
      500: {
        description: 'Dispatch failed',
        content: { 'application/json': { schema: BillingErrorSchema } },
      },
      503: {
        description: 'Webhook not configured',
        content: { 'application/json': { schema: BillingErrorSchema } },
      },
    },
  }),
  async (c) => {
    try {
      const body = await c.req.text();
      const response = await handlePolarWebhook(getDb(c), c.env, {
        body,
        headers: c.req.raw.headers,
      });
      return c.json(response, 200);
    } catch (err) {
      if (err instanceof WebhookHttpError) {
        throw new HTTPException(err.status as 400 | 401 | 413 | 500 | 503, {
          message: err.message,
        });
      }
      throw err;
    }
  },
);
