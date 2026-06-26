import { billingEvents, organizations, type Database } from '@crosmos/db';
import { and, eq, isNull, lte, ne, or } from 'drizzle-orm';
import type { Env } from '../../bindings';
import { invalidateEntitlements } from '../../lib/gate-cache';
import {
  constantTimeEqual,
  planForProduct,
  UnknownPolarProductError,
  verifyCheckoutMetadata,
} from './service';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;

export class WebhookHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'WebhookHttpError';
  }
}

interface PolarWebhookPayload {
  type?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function base64Bytes(value: string): Uint8Array | null {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function toBase64(bytes: ArrayBuffer): string {
  const data = new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]!);
  return btoa(binary);
}

function signingKeys(secret: string): Uint8Array[] {
  const keys = [utf8Bytes(secret)];
  const raw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const decoded = base64Bytes(raw);
  if (decoded && decoded.length > 0) keys.push(decoded);
  return keys;
}

function signatures(header: string): string[] {
  return header
    .split(' ')
    .flatMap((part) => {
      const [version, sig] = part.split(',', 2);
      return version === 'v1' && sig ? [sig] : [];
    });
}

async function hmacBase64(keyBytes: Uint8Array, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toBase64(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)),
  );
}

async function verifyWebhookSignature(input: {
  body: string;
  id: string;
  timestamp: string;
  signature: string;
  secret: string;
}): Promise<void> {
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts)) {
    throw new WebhookHttpError(401, 'invalid_signature');
  }
  const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (skew > MAX_TIMESTAMP_SKEW_SECONDS) {
    throw new WebhookHttpError(401, 'invalid_signature');
  }

  const signedContent = `${input.id}.${input.timestamp}.${input.body}`;
  const candidates = signatures(input.signature);
  if (candidates.length === 0) {
    throw new WebhookHttpError(401, 'invalid_signature');
  }
  for (const key of signingKeys(input.secret)) {
    const expected = await hmacBase64(key, signedContent);
    if (candidates.some((sig) => constantTimeEqual(sig, expected))) return;
  }
  throw new WebhookHttpError(401, 'invalid_signature');
}

function eventType(payload: PolarWebhookPayload): string {
  const raw = payload.type ?? payload.TYPE;
  return typeof raw === 'string' ? raw : '';
}

function data(payload: PolarWebhookPayload): Record<string, unknown> | null {
  return payload.data && typeof payload.data === 'object'
    ? (payload.data as Record<string, unknown>)
    : null;
}

function payloadMetadata(payload: PolarWebhookPayload): Record<string, unknown> | null {
  const d = data(payload);
  const meta = d?.metadata;
  return meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : null;
}

function payloadCustomerId(payload: PolarWebhookPayload): string | null {
  const d = data(payload);
  if (!d) return null;
  const customerId = d.customer_id ?? d.customerId;
  if (typeof customerId === 'string' && customerId) return customerId;
  if (eventType(payload).startsWith('customer.')) {
    const id = d.id;
    if (typeof id === 'string' && id) return id;
  }
  return null;
}

async function resolveOrgId(
  db: Database,
  env: Env,
  payload: PolarWebhookPayload,
): Promise<number | null> {
  const metadata = payloadMetadata(payload);
  if (metadata) {
    const verified = await verifyCheckoutMetadata(env, metadata);
    if (verified) return verified.orgId;
  }

  const customerId = payloadCustomerId(payload);
  if (!customerId) return null;
  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.polarCustomerId, customerId))
    .limit(1);
  return rows[0]?.id ?? null;
}

function parseDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== 'string') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function stringField(record: Record<string, unknown>, snake: string, camel?: string) {
  const value = record[snake] ?? (camel ? record[camel] : undefined);
  return typeof value === 'string' && value ? value : null;
}

// The Polar subscription this event is about. For `subscription.*` events that's
// the object's own `id`; for `order.*` events the subscription is referenced via
// `subscription_id`. Used to ensure a state-changing handler only touches the
// org when the event targets the org's CURRENT subscription — a stale event for
// a superseded subscription (e.g. an old sub revoking after the user already
// re-subscribed) must not clobber the live one.
function eventSubscriptionId(payload: PolarWebhookPayload): string | null {
  const d = data(payload);
  if (!d) return null;
  if (eventType(payload).startsWith('subscription.')) {
    return stringField(d, 'id');
  }
  return stringField(d, 'subscription_id', 'subscriptionId');
}

async function dispatchActive(
  db: Database,
  env: Env,
  payload: PolarWebhookPayload,
  orgId: number,
): Promise<void> {
  const d = data(payload);
  if (!d) return;
  const productId = stringField(d, 'product_id', 'productId');
  if (!productId) return;

  let plan: 'developer' | 'pro';
  try {
    plan = planForProduct(env, productId);
  } catch (err) {
    if (err instanceof UnknownPolarProductError) return;
    throw err;
  }

  const subscriptionId = stringField(d, 'id');
  const customerId = stringField(d, 'customer_id', 'customerId');
  const currentPeriodEnd = parseDate(d.current_period_end ?? d.currentPeriodEnd);
  // A `subscription.updated` fired by a cancel-at-period-end carries the sub
  // still in an "active" Polar status but with `cancel_at_period_end: true`.
  // Treating it as plain `active` would silently undo a user's cancellation in
  // our DB (the /subscription endpoint would read `active` again). Honour the
  // flag so the stored status stays `canceled`; entitlements key off `plan`,
  // which we leave untouched, so paid access still continues until the period
  // end / revoke.
  const cancelAtPeriodEnd =
    d.cancel_at_period_end === true || d.cancelAtPeriodEnd === true;
  const patch: Partial<typeof organizations.$inferInsert> = {
    plan,
    subscriptionStatus: cancelAtPeriodEnd ? 'canceled' : 'active',
    planPending: null,
    updatedAt: new Date(),
  };
  if (subscriptionId) patch.polarSubscriptionId = subscriptionId;
  if (currentPeriodEnd) patch.currentPeriodEnd = currentPeriodEnd;

  const [org] = await db
    .select({ polarCustomerId: organizations.polarCustomerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) return;
  if (customerId && !org.polarCustomerId) patch.polarCustomerId = customerId;

  // Monotonicity guard against out-of-order / retried deliveries. Polar
  // re-signs on retry, so the 5-min skew check gives NO ordering protection: a
  // stale `subscription.updated` or replayed `order.paid` arriving AFTER a
  // `revoked`/`refunded` must NOT resurrect paid entitlements. The revoke/refund
  // handlers null out `currentPeriodEnd`, so we cannot use a stored-period
  // comparison to block a revoked-org replay. Instead, two atomic WHERE
  // conditions encode the rule directly so a stale event can never win a race:
  //
  //   1. While the org is `revoked`, only re-activate when THIS event proves a
  //      currently-live subscription — i.e. it carries a `currentPeriodEnd` in
  //      the FUTURE (genuine re-subscribe / new order). A replay of a past
  //      `order.paid` carries an expired/absent period and is refused. (A fresh
  //      re-purchase always rides in with a future period end, so the legitimate
  //      re-subscribe path is preserved.)
  //   2. For any event carrying a period end, never move the stored
  //      `currentPeriodEnd` BACKWARDS — renewals push it forward; stale replays
  //      carry an older/equal end and are dropped. (Allowed when the stored
  //      value is NULL, e.g. first activation or post-revoke re-subscribe.)
  const guards = [eq(organizations.id, orgId)];

  // Condition 1: unless this event proves a currently-live subscription (a
  // future period end), refuse to lift a `revoked` org back to active.
  const provesLiveSubscription =
    currentPeriodEnd != null && currentPeriodEnd.getTime() > Date.now();
  if (!provesLiveSubscription) {
    guards.push(ne(organizations.subscriptionStatus, 'revoked'));
  }

  // Condition 2: never move the stored period end backwards (drops stale replays
  // that carry an older/equal end; allowed when the stored value is NULL).
  if (currentPeriodEnd) {
    guards.push(
      or(
        isNull(organizations.currentPeriodEnd),
        lte(organizations.currentPeriodEnd, currentPeriodEnd),
      )!,
    );
  }

  await db.update(organizations).set(patch).where(and(...guards));
}

async function bindCustomer(
  db: Database,
  payload: PolarWebhookPayload,
  orgId: number,
): Promise<void> {
  const customerId = payloadCustomerId(payload);
  if (!customerId) return;
  await db
    .update(organizations)
    .set({ polarCustomerId: customerId, updatedAt: new Date() })
    .where(
      and(eq(organizations.id, orgId), isNull(organizations.polarCustomerId)),
    );
}

async function dispatchEvent(
  db: Database,
  env: Env,
  payload: PolarWebhookPayload,
  orgId: number | null,
): Promise<void> {
  if (orgId == null) return;
  const type = eventType(payload);
  if (
    type === 'subscription.created' ||
    type === 'subscription.active' ||
    type === 'subscription.updated' ||
    type === 'order.paid'
  ) {
    await dispatchActive(db, env, payload, orgId);
    return;
  }

  // State-changing handlers below must only fire for the org's CURRENT
  // subscription. When a subscription id is present on the event, scope the
  // update to rows whose stored `polarSubscriptionId` matches — so a stale event
  // for a superseded subscription (the classic cancel-then-resubscribe-before-
  // period-end race) cannot downgrade a freshly-paid subscription. When the
  // event carries no subscription id we fall back to org-scoped matching (legacy
  // behaviour) rather than ignoring the event.
  const subId = eventSubscriptionId(payload);
  const targetsCurrentSubscription = subId
    ? and(
        eq(organizations.id, orgId),
        eq(organizations.polarSubscriptionId, subId),
      )!
    : eq(organizations.id, orgId);

  if (type === 'subscription.past_due') {
    await db
      .update(organizations)
      .set({ subscriptionStatus: 'past_due', updatedAt: new Date() })
      .where(targetsCurrentSubscription);
    await bindCustomer(db, payload, orgId);
    return;
  }

  if (type === 'subscription.canceled') {
    const d = data(payload);
    const currentPeriodEnd = parseDate(d?.current_period_end ?? d?.currentPeriodEnd);
    await db
      .update(organizations)
      .set({
        subscriptionStatus: 'canceled',
        currentPeriodEnd: currentPeriodEnd ?? undefined,
        updatedAt: new Date(),
      })
      .where(targetsCurrentSubscription);
    await bindCustomer(db, payload, orgId);
    return;
  }

  if (type === 'subscription.revoked') {
    await db
      .update(organizations)
      .set({
        plan: 'free',
        subscriptionStatus: 'revoked',
        polarSubscriptionId: null,
        currentPeriodEnd: null,
        planPending: null,
        updatedAt: new Date(),
      })
      .where(targetsCurrentSubscription);
    return;
  }

  if (type === 'order.refunded') {
    await db
      .update(organizations)
      .set({
        plan: 'free',
        subscriptionStatus: 'revoked',
        polarSubscriptionId: null,
        currentPeriodEnd: null,
        planPending: null,
        updatedAt: new Date(),
      })
      .where(targetsCurrentSubscription);
    return;
  }

  if (type === 'customer.state_changed') {
    await bindCustomer(db, payload, orgId);
  }
}

export async function handlePolarWebhook(
  db: Database,
  env: Env,
  input: {
    body: string;
    headers: Headers;
  },
): Promise<{ received: true }> {
  if (utf8Bytes(input.body).byteLength > MAX_BODY_BYTES) {
    throw new WebhookHttpError(413, 'payload_too_large');
  }
  if (!env.POLAR_WEBHOOK_SECRET) {
    throw new WebhookHttpError(503, 'webhook_not_configured');
  }

  const webhookId = input.headers.get('webhook-id');
  const timestamp = input.headers.get('webhook-timestamp');
  const signature = input.headers.get('webhook-signature');
  if (!webhookId || !timestamp || !signature) {
    throw new WebhookHttpError(400, 'missing_webhook_headers');
  }
  await verifyWebhookSignature({
    body: input.body,
    id: webhookId,
    timestamp,
    signature,
    secret: env.POLAR_WEBHOOK_SECRET,
  });

  let payload: PolarWebhookPayload;
  try {
    payload = JSON.parse(input.body) as PolarWebhookPayload;
  } catch {
    throw new WebhookHttpError(400, 'invalid_json');
  }
  const type = eventType(payload);
  const orgId = await resolveOrgId(db, env, payload);

  await db
    .insert(billingEvents)
    .values({
      polarEventId: webhookId,
      orgId,
      eventType: type,
      payload,
    })
    .onConflictDoNothing({ target: billingEvents.polarEventId });

  const [eventRow] = await db
    .select()
    .from(billingEvents)
    .where(eq(billingEvents.polarEventId, webhookId))
    .limit(1);
  if (!eventRow || eventRow.processedAt) return { received: true };

  try {
    await dispatchEvent(db, env, payload, orgId);
    await db
      .update(billingEvents)
      .set({ processedAt: new Date(), error: null })
      .where(eq(billingEvents.id, eventRow.id));
    if (orgId != null) await invalidateEntitlements(env, orgId);
  } catch (err) {
    await db
      .update(billingEvents)
      .set({ error: String(err).slice(0, 1000) })
      .where(eq(billingEvents.id, eventRow.id));
    throw new WebhookHttpError(500, 'dispatch_failed');
  }

  return { received: true };
}
