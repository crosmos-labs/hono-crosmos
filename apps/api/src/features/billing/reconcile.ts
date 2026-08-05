import { createDb, organizations, type Database } from '@crosmos/db';
import { and, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { Env } from '../../bindings';

function gracePeriodDays(env: Env): number {
  const raw = Number(env.BILLING_GRACE_PERIOD_DAYS ?? '7');
  return Number.isFinite(raw) && raw >= 0 ? raw : 7;
}

export async function reconcileExpiredSubscriptions(
  db: Database,
  env: Env,
): Promise<number> {
  const cutoff = new Date(Date.now() - gracePeriodDays(env) * 86_400_000);
  const rows = await db
    .update(organizations)
    .set({
      plan: 'free',
      subscriptionStatus: 'revoked',
      polarSubscriptionId: null,
      currentPeriodEnd: null,
      planPending: null,
      planPendingExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(organizations.subscriptionStatus, ['past_due', 'canceled']),
        lt(organizations.currentPeriodEnd, cutoff),
      ),
    )
    .returning({ id: organizations.id });
  return rows.length;
}

/**
 * Clears `plan_pending` left behind by checkouts that were never paid. Polar
 * sends no webhook when a user abandons a checkout, so these rows have no other
 * writer — without this sweep they keep a dead upgrade pending forever.
 *
 * Reads already expire the field (see `pendingPlan`), so this is about the stored
 * state, not the API response: it stops the column from accumulating lies that a
 * future reader — a support query, an analytics job — would take at face value.
 * Rows whose deadline was never recorded (written before the column existed) are
 * unfalsifiable and therefore also swept.
 */
export async function clearAbandonedCheckouts(db: Database): Promise<number> {
  const rows = await db
    .update(organizations)
    .set({ planPending: null, planPendingExpiresAt: null, updatedAt: new Date() })
    .where(
      and(
        isNotNull(organizations.planPending),
        or(
          isNull(organizations.planPendingExpiresAt),
          lt(organizations.planPendingExpiresAt, new Date()),
        ),
      ),
    )
    .returning({ id: organizations.id });
  return rows.length;
}

export async function runBillingReconciliation(
  env: Env,
): Promise<{ expired: number; abandoned: number }> {
  const db = createDb(env.HYPERDRIVE.connectionString);
  return {
    expired: await reconcileExpiredSubscriptions(db, env),
    abandoned: await clearAbandonedCheckouts(db),
  };
}
