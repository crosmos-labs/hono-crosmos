import { dailyUsage } from '@crosmos/db';
import type { Database } from '@crosmos/db';
import {
  PLAN_DEFAULTS,
  activeGrantedPlan,
  resolveEntitlements,
  type Entitlements,
} from '@crosmos/runtime';
import { and, eq, gte, sql, sum } from 'drizzle-orm';
import { getOrganizationByIdOrThrow } from './service';

export { PLAN_DEFAULTS, activeGrantedPlan, resolveEntitlements };
export type { Entitlements };

export async function getEntitlements(
  db: Database,
  orgId: number,
): Promise<Entitlements> {
  const org = await getOrganizationByIdOrThrow(db, orgId);
  return resolveEntitlements(org);
}

/**
 * Returns total usage for a given metric across the current calendar month
 * (UTC), summed across all users and spaces in the org. Mirrors
 * `get_monthly_usage` in Python — reads the same `daily_usage` table.
 */
export async function getMonthlyUsage(
  db: Database,
  orgId: number,
  key: 'monthly_tokens_ingested' | 'monthly_search_queries',
): Promise<number> {
  const column =
    key === 'monthly_tokens_ingested'
      ? dailyUsage.tokensIngested
      : dailyUsage.searchQueries;

  const rows = await db
    .select({ total: sum(column) })
    .from(dailyUsage)
    .where(
      and(
        eq(dailyUsage.orgId, orgId),
        // First of this month at UTC midnight. `sum` returns null when no
        // rows match, which we coalesce to 0 below.
        gte(dailyUsage.date, sql`date_trunc('month', current_date)`),
      ),
    );

  const raw = rows[0]?.total;
  if (raw === null || raw === undefined) return 0;
  return Number(raw);
}

/**
 * Token-quota gate. Reads `monthly_tokens_ingested` / `monthly_search_queries`
 * from entitlements (`-1` = unlimited, skipped) and compares to summed usage.
 * Throws `QuotaExceededError` when used + increment > limit. Mirrors
 * `check_quota` in `app/services/entitlements/guard.py`.
 *
 * `increment = 0` is the producer-side gate at `POST /sources`: it rejects
 * pre-emptively when the cap has already been hit, without claiming tokens.
 */
export async function checkQuota(
  db: Database,
  orgId: number,
  key: 'monthly_tokens_ingested' | 'monthly_search_queries',
  increment: number = 0,
  entitlements?: Entitlements,
): Promise<void> {
  const ent = entitlements ?? (await getEntitlements(db, orgId));
  const raw = ent[key];
  const limit = typeof raw === 'number' ? raw : -1;
  if (limit === -1) return;
  const used = await getMonthlyUsage(db, orgId, key);
  if (used + increment > limit) {
    throw new QuotaExceededError(key, limit, used);
  }
}

export class QuotaExceededError extends Error {
  constructor(
    public key: string,
    public limit: number,
    public used: number,
  ) {
    super(`Quota exceeded for '${key}': used ${used}, limit ${limit}`);
    this.name = 'QuotaExceededError';
  }
}

/**
 * Mirrors `check_count_quota` in app/services/entitlements/guard.py.
 * `limit == -1` means unlimited (no-op). Otherwise raises when
 * `current_count >= limit`.
 */
export async function checkCountQuota(
  db: Database,
  orgId: number,
  key: string,
  currentCount: number,
): Promise<void> {
  const ent = await getEntitlements(db, orgId);
  const raw = ent[key];
  const limit = typeof raw === 'number' ? raw : -1;
  if (limit === -1) return;
  if (currentCount >= limit) {
    throw new QuotaExceededError(key, limit, currentCount);
  }
}
