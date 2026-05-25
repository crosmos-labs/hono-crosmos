/**
 * Retrieval constants — bit-for-bit port of
 * `app/engine/retrieval/constants.py` + the `RETRIEVAL_*` block of
 * `app/worker/constants.py`.
 *
 * These ARE the ranking. Do NOT round, clean up, or make env-configurable —
 * Python treats them as code. A drift of 0.4 → 0.5 silently changes every
 * result. See docs/retrieval_migration/constants.md.
 */

export const SEMANTIC_MIN_SCORE = 0.1;

export const GIN_CANDIDATE_LIMIT = 100;
export const MIN_KEYWORD_SCORE = 0.1;

export const MAX_DEPTH = 2;
export const DEPTH_DECAY = 0.5;

export const GRAPH_SEED_LIMIT = 5;
export const GRAPH_SEED_THRESHOLD = 0.2;
export const GRAPH_MAX_SEED_ENTITIES = 10;
export const GRAPH_MIN_CONFIDENCE = 0.3;
export const GRAPH_MAX_EDGES_PER_HOP = 200;
export const GRAPH_MEMORY_BUDGET = 100;
export const GRAPH_EDGE_RECENCY_FLOOR = 0.5;
export const GRAPH_EDGE_RECENCY_DAYS = 365.0;

export const RERANKER_MAX_CANDIDATES = 300;

export const LAMBDA = 0.005;
export const SIGMA = 0.1;
export const ALPHA = 0.5;
export const D = 0.5;
// 60 seconds expressed in days. Computed (not pasted) so the float bits match.
export const MIN_RECENCY_GAP_DAYS = 60 / 86400;

export const RECENCY_FLOOR = 0.2;
export const RECENCY_CENTER = 0.5;
export const RECENCY_ALPHA = 0.4;
export const RECENCY_ALPHA_FALLBACK = 0.4;

export const TEMPORAL_CENTER = 0.5;
export const TEMPORAL_CANDIDATE_LIMIT = 50;
export const TEMPORAL_PROXIMITY_ALPHA = 0.3;

export const BOOST_MIN = -0.3;
export const BOOST_MAX = 0.3;

// asyncio.Semaphore bound in Python. On Workers/Hyperdrive connection pooling
// is handled by Hyperdrive, so this maps to nothing today — kept for parity
// reference (docs/retrieval_migration/worker.md).
export const RETRIEVAL_CONNECTION_LIMIT = 20;

export const MMR_LAMBDA = 0.6;
export const MMR_MIN_RELEVANCE = 0.3;

// RRF `k` is a default arg in fusion.py (never overridden by callers), not in
// constants.py — but it is a constant.
export const RRF_K = 60;

// Source-signal fusion weights — all 1.0 (constants.py:SOURCE_WEIGHTS).
export const SOURCE_WEIGHTS = {
  semantic: 1.0,
  keyword: 1.0,
  graph: 1.0,
  temporal: 1.0,
} as const;

// from worker/constants.py (the RETRIEVAL_* block)
export const RETRIEVAL_MAX_QUEUE_DEPTH = 500;
export const RETRIEVAL_RESULT_TIMEOUT_SECONDS = 30;
export const RETRIEVAL_MAX_CONCURRENT_PER_USER = 10;
export const RETRIEVAL_RETRY_AFTER_SECONDS = 3;
export const RETRIEVAL_USER_COUNTER_TTL_SECONDS = 30;

// Per-signal candidate limit (types.py:RetrievalQuery.candidate_pool). Not
// exposed in the API.
export const CANDIDATE_POOL = 50;

/**
 * Whether the cross-encoder reranker is constructed for retrieval. Mirrors
 * Python's `settings.retrieval_reranker_enabled` (env `RETRIEVAL_RERANKER_ENABLED`,
 * default on). Anything other than the literal string `"false"` keeps it on.
 */
export function isRerankerEnabled(value: string | undefined): boolean {
  return value !== 'false';
}
