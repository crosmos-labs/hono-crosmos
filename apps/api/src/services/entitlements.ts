import type { Database, Organization } from '@crosmos/db';
import { getOrganizationByIdOrThrow } from './organizations';

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

const FREE: Entitlements = {
  ...COMMON_FEATURES,
  max_memory_spaces: 3,
  monthly_tokens_ingested: 500_000,
  monthly_search_queries: 5_000,
  rate_limit_rpm: 10,
  rate_limit_per_day: 1_000,
};

const DEVELOPER: Entitlements = {
  ...COMMON_FEATURES,
  max_memory_spaces: 7,
  monthly_tokens_ingested: 5_000_000,
  monthly_search_queries: 50_000,
  rate_limit_rpm: 60,
  rate_limit_per_day: 10_000,
};

const PRO: Entitlements = {
  ...COMMON_FEATURES,
  max_memory_spaces: 50,
  monthly_tokens_ingested: 80_000_000,
  monthly_search_queries: 300_000,
  rate_limit_rpm: 300,
  rate_limit_per_day: 50_000,
};

const ENTERPRISE: Entitlements = {
  ...COMMON_FEATURES,
  max_memory_spaces: -1,
  monthly_tokens_ingested: -1,
  monthly_search_queries: -1,
  rate_limit_rpm: -1,
  rate_limit_per_day: -1,
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
 * Returns total monthly usage for a given metric.
 *
 * Mirrors `get_monthly_usage` in `app/services/entitlements/service.py` but
 * the `daily_usage` table is not yet migrated to Drizzle (it lives in the
 * ingestion/usage path which is Phase 4 in the migration doc). For now this
 * returns 0, matching Python's fallback when the key is unknown.
 *
 * TODO: when daily_usage lands, sum DailyUsage.tokens_ingested / search_queries
 * for the current month.
 */
export async function getMonthlyUsage(
  _db: Database,
  _orgId: number,
  _key: 'monthly_tokens_ingested' | 'monthly_search_queries',
): Promise<number> {
  return 0;
}
