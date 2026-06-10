import { createDb, organizations, type Database } from '@crosmos/db';
import { and, inArray, lt } from 'drizzle-orm';
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

export async function runBillingReconciliation(env: Env): Promise<number> {
  const db = createDb(env.HYPERDRIVE.connectionString);
  return reconcileExpiredSubscriptions(db, env);
}
