// Shared, platform-neutral entitlement resolution used by both the public API
// and the independently deployed admin plane. -1 means unlimited.
export type Entitlements = Record<string, number | boolean | string>;

export interface OrganizationEntitlementSource {
  plan: string;
  grantedPlan: string | null;
  grantedPlanExpiresAt: Date | null;
  entitlements: unknown;
}

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
  max_memory_spaces: -1,
  max_sources_per_space: -1,
  api_keys_per_user: -1,
  zeroentropy_rerank_candidates: 15,
};

export const PLAN_DEFAULTS: Record<string, Entitlements> = {
  free: {
    ...COMMON_FEATURES,
    monthly_tokens_ingested: 500_000,
    monthly_search_queries: 5_000,
    rate_limit_rpm: 10,
    rate_limit_per_day: 1_000,
    mgmt_rate_limit_rpm: 300,
    mgmt_rate_limit_per_day: 30_000,
  },
  developer: {
    ...COMMON_FEATURES,
    monthly_tokens_ingested: 3_000_000,
    monthly_search_queries: 30_000,
    rate_limit_rpm: 60,
    rate_limit_per_day: 10_000,
    mgmt_rate_limit_rpm: 1_200,
    mgmt_rate_limit_per_day: 150_000,
  },
  pro: {
    ...COMMON_FEATURES,
    monthly_tokens_ingested: 40_000_000,
    monthly_search_queries: 200_000,
    rate_limit_rpm: 300,
    rate_limit_per_day: 50_000,
    mgmt_rate_limit_rpm: 3_000,
    mgmt_rate_limit_per_day: 500_000,
  },
  enterprise: {
    ...COMMON_FEATURES,
    monthly_tokens_ingested: -1,
    monthly_search_queries: -1,
    rate_limit_rpm: -1,
    rate_limit_per_day: -1,
    mgmt_rate_limit_rpm: -1,
    mgmt_rate_limit_per_day: -1,
  },
};

export function activeGrantedPlan(
  org: OrganizationEntitlementSource,
  now = new Date(),
): string | null {
  if (!org.grantedPlan || !org.grantedPlanExpiresAt) return null;
  return org.grantedPlanExpiresAt.getTime() > now.getTime() ? org.grantedPlan : null;
}

export function resolveEntitlements(
  org: OrganizationEntitlementSource,
  now = new Date(),
): Entitlements {
  const basePlan = activeGrantedPlan(org, now) ?? org.plan;
  const base = PLAN_DEFAULTS[basePlan] ?? PLAN_DEFAULTS.free!;
  const overrides = org.entitlements && typeof org.entitlements === 'object'
    && !Array.isArray(org.entitlements)
    ? org.entitlements as Entitlements
    : {};
  return { ...base, ...overrides };
}
