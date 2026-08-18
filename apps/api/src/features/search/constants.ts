/**
 * Retrieval constants — bit-for-bit port of
 * `app/engine/retrieval/constants.py` + the `RETRIEVAL_*` block of
 * `app/worker/constants.py`.
 *
 * These ARE the ranking. Do NOT round, clean up, or make env-configurable —
 * Python treats them as code. A drift of 0.4 → 0.5 silently changes every
 * result. See .codex/pipelines.md.
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

/**
 * Post-rerank relevance floors, PER RERANKER MODEL (NOT a Python port — an
 * additive precision gate).
 *
 * A cross-encoder returns a relevance score per candidate. Historically it was
 * used only to ORDER results; the engine always returned `slice(0, topK)`, so
 * when the true answer is 1-2 memories, up to 8 weak distractors still got
 * handed to the reader and induced wrong/"unavailable" answers. This floor
 * drops candidates scoring below it BEFORE the top-K slice, so the answer
 * context is only the memories that are actually on-topic.
 *
 * **The floor is a per-model constant because the score scales are NOT
 * comparable.** Measured against production on 2026-08-19 with the same
 * off-topic query/memory pair ("why are there two theems for catpuccin…" vs
 * "User likes to play Genshin Impact"): zerank-2 scored it 0.030, Voyage
 * rerank-2.5 scored it 0.190 — a 6x difference on identical input. Applying one
 * model's threshold to another either does nothing or silently destroys recall.
 *
 * A model absent from this table gets NO floor: scores are still used for
 * ordering, but absolute filtering is skipped until that model is calibrated.
 * Failing open is correct here — an uncalibrated threshold can only lose recall.
 *
 * ### rerank-2.5 = 0.40 (calibrated 2026-08-19)
 *
 * Measured on production over 91 labeled searches across three corpora (37, 19
 * and 1 memories) — 44 positive queries with known gold memories, 47 off-topic
 * negatives. Queries used `recency_bias: 0` so the reported score is the raw
 * model relevance with no boost applied. Separation was wide and stable:
 *
 * | band                                    | score range   |
 * |-----------------------------------------|---------------|
 * | gold memories, direct questions         | 0.63 – 0.96   |
 * | gold memories, vague/1-word/misspelled  | 0.49 – 0.75   |
 * | irrelevant memories, off-topic queries  | 0.18 – 0.49   |
 *
 * The floor sweep put the knee at 0.40: every one of the 44 positive queries
 * retained at least one gold memory (100% recall, including deliberately hard
 * probes like "oslo", "diet", "resturant reservaton anniversry" and "what
 * should I know before booking my flight?"), while 97.1% of irrelevant results
 * were dropped. The weakest gold observed anywhere scored 0.486, so 0.40 leaves
 * ~0.09 of headroom below it. Recall only starts to break at 0.50, where the
 * first positive query loses all of its gold.
 *
 * Deliberately CONSERVATIVE: the remaining negatives above 0.40 are queries
 * that genuinely share entities with the corpus ("what allergies does my dog
 * have?" at 0.488 against a corpus of allergy facts). Being permissive there is
 * the right call. Re-measure before moving this — `docs/` has the sweep.
 *
 * ### zerank-2 = 0.02 (legacy, UNDER-calibrated)
 *
 * The original value, chosen conservatively before per-model data existed. The
 * 2026-08-19 measurement showed it is far too low to do useful work: the
 * off-topic pair above scored 0.030 and would still pass. Left unchanged
 * because ZeroEntropy is being wound down and no environment should depend on
 * retuning it; staging is the only consumer.
 */
export const RERANK_RELEVANCE_FLOORS: Readonly<Record<string, number>> = {
  'zerank-2': 0.02,
  'rerank-2.5': 0.4,
};

/**
 * The calibrated relevance floor for `model`, or `null` when that model has no
 * measured threshold and must not be absolute-filtered.
 *
 * Note this takes the model that ACTUALLY produced the scores, not the
 * reranker's configured default — Voyage falls back to `rerank-2.5-lite` on a
 * 429, and lite has no calibration of its own.
 */
export function rerankRelevanceFloor(model: string): number | null {
  return RERANK_RELEVANCE_FLOORS[model] ?? null;
}

/**
 * Per-session diversity penalty for the final top-K selection (NOT a Python port
 * — an additive recall-preserving gate, sibling to RERANK_RELEVANCE_FLOORS).
 *
 * The extraction prompt now also stores assistant-provided facts, which roughly
 * doubled memories/session and let one on-query session's cluster monopolise the
 * top-K. For multi-session aggregation ("how many X") the gold instances live in
 * several DISTINCT sessions; when one cluster fills the top-K the other gold
 * sessions fall out and recall@K drops (counting then undercounts). This penalty
 * subtracts `n * PENALTY` from a candidate's final score, where `n` = how many
 * already-selected results share its session — so the 1st memory of each session
 * is prioritised and additional same-session memories must be materially more
 * relevant to still be picked. Diversifies BY SESSION (the aggregation axis),
 * complementing the embedding-space MMR path (`query.diversify`).
 *
 * Tuned conservatively: a strongly dominant single session (single-session-user /
 * single-session-assistant questions, where the answer is one session) still
 * fills the top-K because its relevance gap exceeds the penalty — restoring
 * multi-session recall WITHOUT regressing single-session categories. 0 disables.
 */
export const SESSION_DIVERSITY_PENALTY = 0.1;

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
// reference (.codex/pipelines.md).
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
//
// NOTE: unlike the ranking constants above, this block is OPERATIONAL — it
// tunes admission/backpressure, not results. These are the compile-time
// defaults; each is overridable per-env via `getOperationalLimits` (lib/limits.ts)
// so an incident can be shed without a redeploy.
export const RETRIEVAL_MAX_QUEUE_DEPTH = 500;

/**
 * Server-side ceiling on retrieval work, in seconds.
 *
 * **Was 30s, which was the primary amplifier of the 2026-07-25 incident.**
 *
 * The Crosmos client sends `x-stainless-timeout: 3`, so it abandons a recall at
 * three seconds. The server, however, kept working for up to thirty — and held
 * the caller's concurrency slot for the entire time (the slot is released in the
 * route's `finally`). With `RETRIEVAL_MAX_CONCURRENT_PER_USER = 10`, a user's
 * sustainable throughput was therefore bounded at 10 slots / 30s ≈ 0.33 req/s.
 * Every request above that rate got a concurrency 429 no matter how healthy the
 * backend was, which is why that single class was 52.98% of all search
 * invocations during the incident.
 *
 * Six seconds covers the observed successful p99 (4.388s) with margin. Work that
 * runs longer than this is work nobody is waiting for: the client gave up at
 * three seconds, so completing it at, say, 10.4s (the observed max) produces a
 * response that is discarded while still holding a slot another request needs.
 * Cutting the ceiling raises the per-user throughput bound ~5x and shortens the
 * window in which an abandoned request can starve its own retries.
 *
 * Workers cannot cancel in-flight subrequests, so this bounds when the ROUTE
 * stops waiting and frees the slot — the underlying fetches may run on briefly.
 */
export const RETRIEVAL_RESULT_TIMEOUT_SECONDS = 6;

export const RETRIEVAL_MAX_CONCURRENT_PER_USER = 10;
export const RETRIEVAL_RETRY_AFTER_SECONDS = 3;

/**
 * Grace added to the retrieval timeout to derive a concurrency slot's TTL. The
 * slot must outlive the request that owns it (or the cap silently becomes soft
 * and over-admits), but not by so much that a slot leaked by an isolate
 * termination pins capacity. Four seconds covers admission overhead plus the
 * deferred release landing on `waitUntil`.
 */
export const RETRIEVAL_SLOT_TTL_GRACE_SECONDS = 4;

/**
 * TTL on a per-user concurrency slot — the self-healing net for a request that
 * dies without releasing (e.g. a Cloudflare isolate termination, which kills the
 * `finally`/`waitUntil` release).
 *
 * Was a flat 30s, matching the old retrieval timeout. Now derived from the
 * timeout so the two can never drift apart again: a leaked slot self-heals in
 * ~10s instead of ~30s, so a burst of terminated requests can no longer hold a
 * user at their cap for half a minute.
 */
export const RETRIEVAL_USER_COUNTER_TTL_SECONDS =
  RETRIEVAL_RESULT_TIMEOUT_SECONDS + RETRIEVAL_SLOT_TTL_GRACE_SECONDS;

// Per-signal candidate limit (types.py:RetrievalQuery.candidate_pool). Not
// exposed in the API.
export const CANDIDATE_POOL = 50;

/**
 * Account-wide ceiling on AI fan-out (embeddings + reranker) per minute, across
 * ALL orgs. This is a NOISY-NEIGHBOUR safety ceiling, not a per-user/per-org
 * limit — those are the plan rate limit + concurrency cap. It exists because the
 * shared Cloudflare Workers AI quota is account-global: one org bursting can
 * 429/503 every other tenant (see memory: retrieval ceiling = Workers AI). Sized
 * generously so it only trips on genuine aggregate overload, well above normal
 * peak. The global throttle fails OPEN — a KV hiccup must never block all search.
 */
export const GLOBAL_AI_RPM_CEILING = 3000;

/** Window length (seconds) for the global AI throttle's fixed window. */
export const GLOBAL_AI_WINDOW_SECONDS = 60;

/** `Retry-After` (seconds) returned when the global AI ceiling is hit. */
export const GLOBAL_AI_RETRY_AFTER_SECONDS = 5;

/**
 * Whether the cross-encoder reranker is constructed for retrieval. Mirrors
 * Python's `settings.retrieval_reranker_enabled` (env `RETRIEVAL_RERANKER_ENABLED`,
 * default on). Anything other than the literal string `"false"` keeps it on.
 *
 * IMPORTANT — the reranker is ON BY DEFAULT and must stay that way, in every
 * environment including local dev and benchmarks. It is a core part of
 * retrieval quality, not an optional add-on. Only turn it off when the user
 * explicitly asks for it off (e.g. measuring pre-rerank ranking in isolation).
 * Do NOT default it to false for convenience — leaving it unset = enabled.
 */
export function isRerankerEnabled(value: string | undefined): boolean {
  return value !== 'false';
}
