export type SearchAdmissionOutcome =
  | { accepted: true }
  | {
      accepted: false;
      stage: 'plan_rate_limit' | 'monthly_quota';
      reason: unknown;
    };

/**
 * Join the two independent admission reads while preserving the historical
 * outward error precedence: a plan-limit failure wins when both reject.
 * Callers must not start provider work until this promise resolves accepted.
 */
export async function awaitSearchAdmission(
  planCheck: Promise<unknown>,
  quotaCheck: Promise<unknown>,
): Promise<SearchAdmissionOutcome> {
  const [planResult, quotaResult] = await Promise.allSettled([
    planCheck,
    quotaCheck,
  ]);

  if (planResult.status === 'rejected') {
    return {
      accepted: false,
      stage: 'plan_rate_limit',
      reason: planResult.reason,
    };
  }
  if (quotaResult.status === 'rejected') {
    return {
      accepted: false,
      stage: 'monthly_quota',
      reason: quotaResult.reason,
    };
  }
  return { accepted: true };
}
