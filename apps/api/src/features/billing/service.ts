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

async function polarRequest<T>(
  env: Env,
  path: string,
  init: RequestInit,
): Promise<T> {
  if (!env.POLAR_ACCESS_TOKEN) {
    throw new BillingConfigError('polar_access_token is not configured');
  }
  const response = await fetch(`${polarBaseUrl(env)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.POLAR_ACCESS_TOKEN}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new PolarRequestError(body || response.statusText, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
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
