import { dailyUsage } from '@crosmos/db';
import type { Database, Organization } from '@crosmos/db';
import { and, eq, gte, sql, sum } from 'drizzle-orm';
import { getOrganizationByIdOrThrow } from './service';

// Mirrors app/services/entitlements/plans.py and schema.py exactly.
// -1 means "unlimited".
export type Entitlements = Record<string, number | boolean | string>;

const COMMON_FEATURES: Entitlements = {
  graph_retrieval: true,
  cross_encoder_reranking: true,
  custom_embeddings: true,
  audit_log: true,
  sso: true,
  lazy_rerank: false,
  prompt_caching: true,
  max_graph_depth: 3,
  retention_days: -1,
  max_members: -1,
  max_sources_per_space: -1,
  api_keys_per_user: -1,
  zeroentropy_rerank_candidates: 15,
};

// `rate_limit_rpm` / `rate_limit_per_day` gate the EXPENSIVE AI paths only
// (search + ingestion); they're enforced in those routes' own gates.
// `mgmt_rate_limit_rpm` / `mgmt_rate_limit_per_day` are a separate, much looser
// guard applied default-on to every authenticated route (CRUD, dashboard, etc.)
// so a normal dashboard load — which fans out several calls — isn't choked by
// the tight AI budget, while abuse is still bounded. See `requireAuth`.
const FREE: Entitlements = {
  ...COMMON_FEATURES,
  max_memory_spaces: 3,
  monthly_tokens_ingested: 500_000,
  monthly_search_queries: 5_000,
  rate_limit_rpm: 10,
  rate_limit_per_day: 1_000,
  mgmt_rate_limit_rpm: 300,
  mgmt_rate_limit_per_day: 30_000,
};

const DEVELOPER: Entitlements = {
  ...COMMON_FEATURES,
  max_memory_spaces: 7,
  monthly_tokens_ingested: 3_000_000,
  monthly_search_queries: 30_000,
  rate_limit_rpm: 60,
  rate_limit_per_day: 10_000,
  mgmt_rate_limit_rpm: 1_200,
  mgmt_rate_limit_per_day: 150_000,
};

const PRO: Entitlements = {
  ...COMMON_FEATURES,
  max_memory_spaces: 50,
  monthly_tokens_ingested: 40_000_000,
  monthly_search_queries: 200_000,
  rate_limit_rpm: 300,
  rate_limit_per_day: 50_000,
  mgmt_rate_limit_rpm: 3_000,
  mgmt_rate_limit_per_day: 500_000,
};

const ENTERPRISE: Entitlements = {
  ...COMMON_FEATURES,
  max_memory_spaces: -1,
  monthly_tokens_ingested: -1,
  monthly_search_queries: -1,
  rate_limit_rpm: -1,
  rate_limit_per_day: -1,
  mgmt_rate_limit_rpm: -1,
  mgmt_rate_limit_per_day: -1,
};

export const PLAN_DEFAULTS: Record<string, Entitlements> = {
  free: FREE,
  developer: DEVELOPER,
  pro: PRO,
  enterprise: ENTERPRISE,
};

export function resolveEntitlements(org: Organization): Entitlements {
  const base = PLAN_DEFAULTS[org.plan] ?? FREE;
  const overrides = (org.entitlements as Entitlements | null) ?? {};
  return { ...base, ...overrides };
}

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
