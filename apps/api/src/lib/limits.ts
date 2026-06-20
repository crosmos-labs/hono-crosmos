import type { Env } from '../bindings';
import {
  MAX_PENDING_JOBS_PER_USER,
  MAX_QUEUE_DEPTH,
  STALE_JOB_MINUTES,
} from '../features/sources/constants';
import {
  GLOBAL_AI_RPM_CEILING,
  RETRIEVAL_MAX_CONCURRENT_PER_USER,
} from '../features/search/constants';

/**
 * Operational limits — the admission/backpressure knobs — resolved from env with
 * the compile-time constants as defaults (issue #6). Previously these were
 * compile-time constants, so tuning the benchmark (or shedding load in an
 * incident) meant a code edit + redeploy. They're now env-overridable in one
 * typed place; the constants stay as the sane defaults so behavior is unchanged
 * unless an override is set. Set the matching `[vars]` in `wrangler.toml`
 * (per-env) or a `.dev.vars` line to override.
 */
export interface OperationalLimits {
  /** Per-user cap on active (non-stale pending+processing) ingestion jobs. */
  maxPendingJobsPerUser: number;
  /** Global cap on in-flight ingestion jobs (the queue-depth gate). */
  maxQueueDepth: number;
  /** Minutes after which an in-flight job is treated as orphaned (gates + reaper). */
  staleJobMinutes: number;
  /** Per-user cap on concurrent /search requests. */
  retrievalMaxConcurrentPerUser: number;
  /** Account-wide AI requests-per-minute ceiling (embedder + reranker). */
  globalAiRpmCeiling: number;
}

/**
 * Parse a positive integer from an env var, falling back to `fallback` on
 * missing/blank/invalid/out-of-range input. Defensive on purpose: a typo in a
 * deploy var should degrade to the safe default, not silently disable a gate
 * (e.g. `NaN >= limit` is always false, which would wedge a gate open).
 */
export function envInt(
  raw: string | undefined,
  fallback: number,
  min = 1,
): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === '') return fallback;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < min) return fallback;
  return n;
}

export function getOperationalLimits(env: Env): OperationalLimits {
  return {
    maxPendingJobsPerUser: envInt(
      env.MAX_PENDING_JOBS_PER_USER,
      MAX_PENDING_JOBS_PER_USER,
    ),
    maxQueueDepth: envInt(env.MAX_QUEUE_DEPTH, MAX_QUEUE_DEPTH),
    staleJobMinutes: envInt(env.STALE_JOB_MINUTES, STALE_JOB_MINUTES),
    retrievalMaxConcurrentPerUser: envInt(
      env.RETRIEVAL_MAX_CONCURRENT_PER_USER,
      RETRIEVAL_MAX_CONCURRENT_PER_USER,
    ),
    globalAiRpmCeiling: envInt(
      env.GLOBAL_AI_RPM_CEILING,
      GLOBAL_AI_RPM_CEILING,
    ),
  };
}
