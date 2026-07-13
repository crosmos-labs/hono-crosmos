import { organizations, type Database, type Organization } from '@crosmos/db';
import { eq } from 'drizzle-orm';
import type { Env } from '../../bindings';
import { tokenUrlSafe } from '../../lib/crypto';
import { PLAN_DEFAULTS, type Entitlements } from '../orgs/entitlements';
import { getOrganizationByIdOrThrow } from '../orgs/service';
import type { PurchasablePlanSchema } from './schemas';
import type { z } from '@hono/zod-openapi';

export class BillingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingConfigError';
  }
}

export class PolarRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'PolarRequestError';
  }
}

export class UnknownPolarProductError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownPolarProductError';
  }
}

export class PaymentNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentNotFoundError';
  }
}

export type PurchasablePlan = z.infer<typeof PurchasablePlanSchema>;

export interface PlanCatalogEntry {
  plan: 'free' | 'developer' | 'pro' | 'enterprise';
  price_usd: number;
  max_memory_spaces: number;
  monthly_tokens_ingested: number;
  monthly_search_queries: number;
  status: 'live' | 'coming_soon';
}

const PLAN_PRICING_USD = {
  free: 0,
  developer: 19,
  pro: 299,
  enterprise: 0,
} as const;

const PLAN_STATUS = {
  free: 'live',
  developer: 'live',
  pro: 'live',
  enterprise: 'coming_soon',
} as const;

function numberEntitlement(ent: Entitlements, key: string): number {
  const value = ent[key];
  return typeof value === 'number' ? value : -1;
}

export function getPlanCatalog(): PlanCatalogEntry[] {
  return (['free', 'developer', 'pro', 'enterprise'] as const).map((plan) => {
    const ent = PLAN_DEFAULTS[plan]!;
    return {
      plan,
      price_usd: PLAN_PRICING_USD[plan],
      max_memory_spaces: numberEntitlement(ent, 'max_memory_spaces'),
      monthly_tokens_ingested: numberEntitlement(ent, 'monthly_tokens_ingested'),
      monthly_search_queries: numberEntitlement(ent, 'monthly_search_queries'),
      status: PLAN_STATUS[plan],
    };
  });
}

export function subscriptionResponse(org: Organization) {
  return {
    plan: org.plan,
    subscription_status: org.subscriptionStatus,
    current_period_end: org.currentPeriodEnd?.toISOString() ?? null,
    plan_pending: org.planPending,
  };
}

function polarBaseUrl(env: Env): string {
  return env.POLAR_ENVIRONMENT === 'production'
    ? 'https://api.polar.sh/v1'
    : 'https://sandbox-api.polar.sh/v1';
}

/**
 * Bounds every Polar call. Without this the fetch can hang indefinitely and wedge
 * the isolate — the same failure mode that stalled ingestion under load. A user
 * is better served by a fast 502 than a request that never returns.
 */
const POLAR_TIMEOUT_MS = 10_000;

async function polarRequest<T>(
  env: Env,
  path: string,
  init: RequestInit,
): Promise<T> {
  if (!env.POLAR_ACCESS_TOKEN) {
    throw new BillingConfigError('polar_access_token is not configured');
  }
  let response: Response;
  try {
    response = await fetch(`${polarBaseUrl(env)}${path}`, {
      ...init,
      signal: AbortSignal.timeout(POLAR_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${env.POLAR_ACCESS_TOKEN}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new PolarRequestError('polar request timed out', 504);
    }
    throw err;
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new PolarRequestError(body || response.statusText, response.status);
  }
  // Not every success carries a body: 204 has none by definition, and Polar's
  // "trigger invoice generation" returns a bodyless 202. Blindly calling
  // `.json()` on those throws a SyntaxError on the empty string, so parse only
  // when there is actually something to parse.
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export function productIdForPlan(env: Env, plan: string): string {
  if (plan !== 'developer' && plan !== 'pro') {
    throw new BillingConfigError(`plan '${plan}' is not purchasable`);
  }
  const productId =
    plan === 'developer' ? env.POLAR_PRODUCT_ID_DEVELOPER : env.POLAR_PRODUCT_ID_PRO;
  if (!productId) {
    throw new BillingConfigError(`polar_product_id_${plan} is not configured`);
  }
  return productId;
}

export function planForProduct(env: Env, productId: string): PurchasablePlan {
  if (env.POLAR_PRODUCT_ID_DEVELOPER && productId === env.POLAR_PRODUCT_ID_DEVELOPER) {
    return 'developer';
  }
  if (env.POLAR_PRODUCT_ID_PRO && productId === env.POLAR_PRODUCT_ID_PRO) {
    return 'pro';
  }
  throw new UnknownPolarProductError(`unknown polar product_id: ${productId}`);
}

function billingSuccessUrl(env: Env): string {
  return env.BILLING_SUCCESS_URL ?? `${env.APP_BASE_URL}/billing/success`;
}

export async function createCheckoutSession(
  db: Database,
  env: Env,
  input: { orgId: number; plan: PurchasablePlan },
): Promise<string> {
  const org = await getOrganizationByIdOrThrow(db, input.orgId);
  // A checkout always creates a NEW Polar subscription. If the org already has a
  // live subscription (active, in dunning, or canceled-but-still-in-period), a
  // second checkout would leave two subscriptions billing in parallel while the
  // org only tracks the last `polarSubscriptionId` — a silent double-charge, and
  // the old sub's eventual revoke would clobber the new one. Plan changes
  // (upgrade/downgrade/re-activate) must go through the customer portal instead.
  const hasLiveSubscription =
    !!org.polarSubscriptionId &&
    (org.subscriptionStatus === 'active' ||
      org.subscriptionStatus === 'past_due' ||
      org.subscriptionStatus === 'canceled');
  if (hasLiveSubscription) {
    throw new BillingConfigError('existing_subscription_must_be_managed_in_portal');
  }
  if (!org.billingEmail) {
    throw new BillingConfigError('billing_email is not set on organization');
  }

  const checkout = await polarRequest<{
    url?: string;
    checkout_url?: string;
  }>(env, '/checkouts/', {
    method: 'POST',
    body: JSON.stringify({
      products: [productIdForPlan(env, input.plan)],
      customer_email: org.billingEmail,
      success_url: billingSuccessUrl(env),
      metadata: await buildCheckoutMetadata(env, {
        orgId: org.id,
        plan: input.plan,
      }),
    }),
  });

  const url = checkout.url ?? checkout.checkout_url;
  if (!url) {
    throw new PolarRequestError('checkout URL missing from provider response', 502);
  }

  await db
    .update(organizations)
    .set({ planPending: input.plan, updatedAt: new Date() })
    .where(eq(organizations.id, org.id));

  return url;
}

export async function createCustomerPortalSession(
  db: Database,
  env: Env,
  orgId: number,
): Promise<string> {
  const org = await getOrganizationByIdOrThrow(db, orgId);
  if (!org.polarCustomerId) {
    throw new BillingConfigError('no_customer_on_file');
  }
  const session = await polarRequest<{
    customer_portal_url?: string;
    customerPortalUrl?: string;
  }>(env, '/customer-sessions/', {
    method: 'POST',
    body: JSON.stringify({ customer_id: org.polarCustomerId }),
  });
  const url = session.customer_portal_url ?? session.customerPortalUrl;
  if (!url) {
    throw new PolarRequestError('portal URL missing from provider response', 502);
  }
  return url;
}

export async function cancelSubscription(
  db: Database,
  env: Env,
  orgId: number,
): Promise<void> {
  const org = await getOrganizationByIdOrThrow(db, orgId);
  if (!org.polarSubscriptionId) {
    throw new BillingConfigError('no_active_subscription');
  }
  if (org.subscriptionStatus === 'canceled' || org.subscriptionStatus === 'revoked') {
    throw new BillingConfigError('subscription_already_canceled');
  }
  await polarRequest(env, `/subscriptions/${org.polarSubscriptionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ cancel_at_period_end: true }),
  });
  await db
    .update(organizations)
    .set({ subscriptionStatus: 'canceled', updatedAt: new Date() })
    .where(eq(organizations.id, org.id));
}

/** Polar's `Order` — only the fields we surface. */
interface PolarOrder {
  id: string;
  status: string;
  paid: boolean;
  created_at: string;
  subtotal_amount: number;
  discount_amount: number;
  tax_amount: number;
  total_amount: number;
  refunded_amount: number;
  currency: string;
  billing_reason: string;
  description?: string | null;
  invoice_number?: string | null;
  is_invoice_generated: boolean;
  customer_id: string;
  product_id?: string | null;
  product?: { name?: string | null } | null;
}

interface PolarList<T> {
  items: T[];
  pagination: { total_count: number; max_page: number };
}

/**
 * `planForProduct` throws on an unrecognised product. Payment history is
 * historical: it can legitimately contain orders for products that have since
 * been renamed, archived, or re-created with a new id. A stale product must not
 * blow up the whole page, so unknown products degrade to `null`.
 */
function planForProductOrNull(env: Env, productId: string | null | undefined) {
  if (!productId) return null;
  try {
    return planForProduct(env, productId);
  } catch {
    return null;
  }
}

function paymentResponse(env: Env, order: PolarOrder) {
  return {
    id: order.id,
    status: order.status as
      | 'draft'
      | 'pending'
      | 'paid'
      | 'refunded'
      | 'partially_refunded'
      | 'void',
    paid: order.paid,
    created_at: order.created_at,
    subtotal_amount: order.subtotal_amount,
    discount_amount: order.discount_amount,
    tax_amount: order.tax_amount,
    total_amount: order.total_amount,
    refunded_amount: order.refunded_amount,
    currency: order.currency,
    billing_reason: order.billing_reason,
    description: order.description ?? null,
    invoice_number: order.invoice_number ?? null,
    invoice_available: order.is_invoice_generated,
    product_name: order.product?.name ?? null,
    plan: planForProductOrNull(env, order.product_id),
  };
}

export async function listPayments(
  db: Database,
  env: Env,
  input: { orgId: number; page: number; limit: number },
) {
  const org = await getOrganizationByIdOrThrow(db, input.orgId);
  // An org that has never checked out has no Polar customer. That is an empty
  // history, not an error — a free-plan dashboard should render a clean list.
  if (!org.polarCustomerId) {
    return {
      payments: [],
      pagination: {
        page: input.page,
        limit: input.limit,
        total_count: 0,
        max_page: 0,
      },
    };
  }

  const query = new URLSearchParams({
    customer_id: org.polarCustomerId,
    page: String(input.page),
    limit: String(input.limit),
    sorting: '-created_at',
  });
  const result = await polarRequest<PolarList<PolarOrder>>(
    env,
    `/orders/?${query.toString()}`,
    { method: 'GET' },
  );

  return {
    payments: result.items.map((order) => paymentResponse(env, order)),
    pagination: {
      page: input.page,
      limit: input.limit,
      total_count: result.pagination.total_count,
      max_page: result.pagination.max_page,
    },
  };
}

/**
 * Resolves an order's invoice URL, after proving the order belongs to the caller's
 * org. Polar order ids are opaque UUIDs but they are NOT a capability — without
 * this ownership check any org owner could read any other org's invoice by id.
 * A foreign or unknown id gets a flat 404 so the endpoint can't be used to probe
 * which order ids exist.
 */
export async function getPaymentInvoice(
  db: Database,
  env: Env,
  input: { orgId: number; orderId: string },
): Promise<{ status: 'ready'; url: string } | { status: 'generating' }> {
  const org = await getOrganizationByIdOrThrow(db, input.orgId);
  if (!org.polarCustomerId) {
    throw new PaymentNotFoundError('payment_not_found');
  }

  let order: PolarOrder;
  try {
    order = await polarRequest<PolarOrder>(env, `/orders/${input.orderId}`, {
      method: 'GET',
    });
  } catch (err) {
    if (err instanceof PolarRequestError && err.status === 404) {
      throw new PaymentNotFoundError('payment_not_found');
    }
    throw err;
  }

  if (order.customer_id !== org.polarCustomerId) {
    throw new PaymentNotFoundError('payment_not_found');
  }

  // Polar generates invoice PDFs lazily. Trigger generation and let the client
  // retry rather than blocking the request on an async job we can't await.
  if (!order.is_invoice_generated) {
    await polarRequest(env, `/orders/${input.orderId}/invoice`, { method: 'POST' });
    return { status: 'generating' };
  }

  const invoice = await polarRequest<{ url: string }>(
    env,
    `/orders/${input.orderId}/invoice`,
    { method: 'GET' },
  );
  return { status: 'ready', url: invoice.url };
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message),
  );
  return [...new Uint8Array(signature)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function buildCheckoutMetadata(
  env: Env,
  input: { orgId: number; plan: PurchasablePlan },
): Promise<Record<string, string>> {
  if (!env.BILLING_METADATA_SECRET) {
    throw new BillingConfigError('billing_metadata_secret is not configured');
  }
  const nonce = tokenUrlSafe(16);
  const issuedAt = Math.floor(Date.now() / 1000);
  const message = `${input.orgId}|${input.plan}|${nonce}|${issuedAt}`;
  return {
    org_id: String(input.orgId),
    plan: input.plan,
    nonce,
    issued_at: String(issuedAt),
    sig: await hmacHex(env.BILLING_METADATA_SECRET, message),
  };
}

export async function verifyCheckoutMetadata(
  env: Env,
  metadata: Record<string, unknown>,
): Promise<{ orgId: number; plan: string } | null> {
  if (!env.BILLING_METADATA_SECRET) return null;
  const orgId = Number(metadata.org_id);
  const plan = String(metadata.plan ?? '');
  const nonce = String(metadata.nonce ?? '');
  const issuedAt = Number(metadata.issued_at);
  const sig = String(metadata.sig ?? '');
  if (!Number.isInteger(orgId) || !plan || !nonce || !Number.isInteger(issuedAt) || !sig) {
    return null;
  }
  // The signature already binds (orgId, plan) authentically, so the only job of
  // this window is to bound how long a captured metadata blob stays replayable —
  // and a replay merely re-asserts the true (orgId, plan), so the risk is low.
  // It must therefore comfortably exceed the lifetime of a Polar checkout link:
  // a 24h window silently dropped activations when a user paid a day after
  // generating the link (first purchase → customer not yet bound → no fallback →
  // money taken, no plan). 30 days covers any realistic pay-later gap.
  const age = Math.floor(Date.now() / 1000) - issuedAt;
  if (age < 0 || age > 30 * 86_400) return null;
  const expected = await hmacHex(
    env.BILLING_METADATA_SECRET,
    `${orgId}|${plan}|${nonce}|${issuedAt}`,
  );
  if (!constantTimeEqual(expected, sig)) return null;
  return { orgId, plan };
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
