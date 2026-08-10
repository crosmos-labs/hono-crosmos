/**
 * Pipeline-wide constants. Mirrors the Python `app/engine/extractors/constants.py`,
 * `app/engine/extractors/resolve_entity.py`, `app/engine/extractors/dedup_helpers.py`,
 * `app/worker/constants.py`, and `app/engine/ingestion/sessions.py`.
 *
 * Hard-coded, not env-configurable — Python treats them as code. See
 * .codex/pipelines.md.
 */

// Extraction
export const MODEL_NAME = 'openai/gpt-4.1-mini';
// NOTE: the embedding dimension is intentionally NOT a constant here. It is a
// property of the configured embedder (`embedder.dimensions`, derived from
// EMBEDDING_DIMENSIONS env via `getEmbedder`/`assertEmbeddingSpace`). The
// pipeline validates vectors against `embedder.dimensions` so there is a single
// source of truth and no constant can drift from the deployed model / Qdrant
// collection / Vectorize index dimension. See issue #3.
export const MIN_IMPORTANCE_SCORE = 0.2;
export const MIN_RELATION_CONFIDENCE = 0.7;
// Minimum word count for a fact to survive normalization (issue #8). Drops
// 1–2 word fragments ("ok thanks", "yes") while KEEPING terse-but-real facts
// like "User likes ramen" (3 words). Previously hardcoded at <4, which silently
// dropped valid 3-word facts the extraction prompt explicitly produces.
export const MIN_FACT_WORDS = 3;
// Upper bound on extraction output so a runaway / pathological chunk can't emit
// an unbounded completion. Generous — a bounded chunk yields a handful of facts;
// truncation (finish_reason=length) is surfaced as a clear error (issue #7).
export const EXTRACTION_MAX_TOKENS = 4_000;

// Entity name shape
export const ENTITY_NAME_MAX_LENGTH = 80;
export const ENTITY_NAME_MAX_WORDS = 5;
export const DEFAULT_ENTITY_TYPE = 'object';

// Existing-memory dedup hint
export const EXISTING_MEMORY_LOOKUP_LIMIT = 10;

// Entity resolution — embedding pre-filter
export const CANDIDATE_POOL_THRESHOLD = 0.5; // cosine distance ceiling
export const CANDIDATE_POOL_LIMIT = 50;

// Entity resolution — fuzzy matcher
export const RESOLVE_THRESHOLD = 90;
export const CANDIDATE_THRESHOLD = 60;
export const CANDIDATE_LIMIT = 10;
export const MIN_FUZZY_LENGTH = 3;

// Worker / queue
export const SOURCE_RETRY_ATTEMPTS = 3;
export const SOURCE_RETRY_DELAY_MS = 5_000; // multiplied by attempt → 5s, 10s, 15s
export const MAX_QUEUE_DEPTH = 5_000;
export const RETRY_AFTER_SECONDS = 30;
export const MAX_PENDING_JOBS_PER_USER = 5_000;
// Lower bound on how long a silently-dead job's lease is held before the queue
// backstop can re-claim it: this is the dominant term in worst-case recovery
// latency. Set to 5 min (was 10) — a fire-and-forget RPC run that's evicted
// mid-flight (`waitUntil` has no auto-retry) is recovered in ~5 min instead of
// ~10. Stays safely above a healthy job's worst gap between lease heartbeats
// (~210s with CHUNK_HEARTBEAT_INTERVAL_MS=60s), so it won't double-claim a
// slow-but-alive job; and `max_retries(15) × BACKSTOP_RETRY_DELAY_SECONDS(60)`
// = 15 min still outlasts it (see the invariant on BACKSTOP_RETRY_DELAY_SECONDS).
export const STUCK_JOB_TIMEOUT_MINUTES = 5;
export const MONITOR_INTERVAL_SECONDS = 60;

// Job lease (claim) — a job is claimed by transitioning pending -> processing
// with a fresh `started_at`. A second trigger may only re-claim a `processing`
// job once its lease has expired (i.e. it looks abandoned). The lease must
// exceed the worst-case wall-clock of a single healthy job so the queue
// backstop never double-runs a job that's still legitimately in flight. Reuses
// the existing stuck-job timeout so both notions of "abandoned" agree.
export const JOB_LEASE_MS = STUCK_JOB_TIMEOUT_MINUTES * 60_000;
// When the queue backstop finds a job still healthily in flight (claimed by the
// direct RPC path), it re-queues the message with this delay to re-check later
// rather than acking (which would drop the only durable copy). Polls until the
// job reaches a terminal state or its lease expires. Paired with a high
// `max_retries` in wrangler.toml so the poll window outlasts JOB_LEASE_MS.
export const BACKSTOP_RETRY_DELAY_SECONDS = 60;

// Continuations vs failure attempts (P0-C).
//
// `max_retries = 15` on the queue consumer is a FAILURE budget: it exists so a
// job whose RPC run died silently is re-polled until its lease expires, and so a
// persistently-broken job eventually reaches the DLQ. Healthy forward progress
// must NOT spend it. A large source deliberately processes
// MAX_CHUNKS_PER_INVOCATION chunks per invocation and asks to be resumed — with
// a shared budget, a valid 200-chunk source exhausts 15 deliveries and dead-
// letters without a single processing failure.
//
// So a run that ADVANCED ITS CHECKPOINT publishes a fresh continuation message
// (attempt counter back to 1) and acks the current delivery, while transient
// failures, unhandled errors, and in-flight polling stay on the delivery retry
// budget. `continuation_count` rides along purely as a bound + observability.
//
// The real loop guard is the no-progress check in the consumer: a continuation
// that processes zero chunks and still asks to continue is refused and falls
// back to the delivery retry budget, so it becomes visible via the DLQ instead
// of spinning forever. This ceiling is the belt-and-braces backstop, sized off
// the legitimate worst case: MAX_SOURCES_PER_JOB (10, api-side) sources of
// MAX_CHUNKS_PER_SOURCE (500) chunks at MAX_CHUNKS_PER_INVOCATION (8) per
// invocation = 625, plus slack for per-source batch boundaries.
export const MAX_JOB_CONTINUATIONS = 800;

// Session ingestion
export const SESSION_SEGMENT_SIZE = 4;
export const SESSION_LOOKBACK_WINDOW = 4;

// Text / markdown chunking (issue #7). Until the full chonkie port lands, a
// recursive character splitter keeps text/markdown sources from being a single
// unbounded chunk — which both risked extraction-output truncation and blew the
// embedder's input token limit on the Stage-1 dedup hint. Target ~2k chars per
// chunk (a few paragraphs ≈ ~500 tokens, comparable to a 4-turn conversation
// window); never emit a chunk larger than the hard cap.
export const TEXT_CHUNK_TARGET_CHARS = 2_000;
export const TEXT_CHUNK_MAX_CHARS = 4_000;

// Hard cap for a single conversation chunk, mirroring the text hard cap. A 4-turn
// window is normally ~2k chars, but long turns can blow past the embedder's input
// limit and truncate extraction; oversized windows are split to respect this.
export const CONVERSATION_MAX_CHARS = 4_000;

// Conversation chunking — a source runs entirely in ONE Cloudflare invocation,
// which is bounded to 1000 subrequests; each chunk spends ~6 of them (search
// embed + vector query + 2 LLM calls + batch embed + vector upsert; DB queries
// go over a TCP socket and don't count toward the fetch subrequest cap). A very
// long conversation chunks into many windows and can approach that ceiling. We
// WARN past this threshold for observability; the hard bounds below enforce it.
export const CONVERSATION_CHUNK_WARN_THRESHOLD = 50;

// Per-invocation chunk BATCH size (issues #1 / #2 / #9). A single Cloudflare
// invocation is bounded to 1000 fetch subrequests AND a wall-clock/duration the
// runtime will `cancel` past. The old estimate — "~6 subrequests per chunk, so
// ~130 chunks fit" — was wrong on BOTH axes and was the root cause of the
// source-520 stall (2026-07-17): a 16-chunk markdown source blew the subrequest
// cap (a Qdrant delete threw "Too many subrequests …", status 504, retryable)
// and separately got the invocation `canceled` at ~40-80s. The real per-chunk
// cost is far higher than 6 — each chunk issues a search embed, a vector query,
// two extraction LLM calls, a batch embed, a vector upsert, AND several Postgres
// round-trips over the Hyperdrive TCP socket (which DO count against the
// invocation's connection/subrequest budget) — plus per-batch entity resolution
// (candidate-pool vector queries + upserts). Empirically 16 chunks + Stage 8
// exhausted the 1000-cap.
//
// So a source is now processed in BATCHES of at most this many chunks per
// invocation. `ingestSource` persists a durable `ingest_next_sequence`
// checkpoint in `source.meta` after each committed batch; if more chunks remain
// it returns `remainingChunkCount > 0` and the job handler re-queues to continue
// in a fresh invocation. This makes forward progress guaranteed and bounds a
// single invocation's subrequest + time cost, whatever the source size.
//
// 8 chunks/invocation keeps the worst-case well under the 1000-cap (~8 × ~20
// subrequests + Stage 8 + a targeted purge ≈ ~250, comfortable headroom) and
// keeps wall-clock to ~20-40s. Raise it only after measuring real subrequest
// counts in prod (see the `ingestion_ai_error` + outcome metrics).
export const SUBREQUESTS_PER_CHUNK = 20;
export const MAX_CHUNKS_PER_INVOCATION = 8;
// Bounded concurrency for chunks WITHIN a batch (issue #1). Chunks in a batch run
// concurrently up to this limit to cut wall-clock; the per-source cross-chunk
// dedup (`seenFactKeys`) is best-effort and tolerates the race (the Stage-1
// vector dedup-hint still catches cross-chunk duplicates). The subrequest budget
// is per-invocation TOTAL, not concurrent, so concurrency doesn't change the cap
// math — only latency. Keep modest so a batch's concurrent subrequests don't
// spike against provider rate limits.
export const CHUNK_CONCURRENCY = 3;
// Abuse ceiling on total chunks for a SINGLE source. Decoupled from the
// per-invocation batch now that sources checkpoint + resume across invocations
// (they no longer have to fit in one invocation). A source over this is failed
// terminally with a clear "split it" error. Set high — well above the max legal
// conversation (MAX_CONVERSATION_MESSAGES=500 / segment 4 = 125 chunks) — so
// only genuinely pathological input trips it.
export const MAX_CHUNKS_PER_SOURCE = 500;
// Mid-source lease heartbeat (issue #1). The queue backstop reclaims a job whose
// `started_at` hasn't advanced for JOB_LEASE_MS (5 min). The per-source status
// write only beats BETWEEN sources, so a single long source (many chunks) could
// blow the lease while perfectly healthy and get double-claimed. Re-stamp
// `started_at` mid-source at this cadence — well under the lease, throttled so it
// costs at most a handful of DB writes per long source. Lowered to 60s (was
// 120s) so the worst gap between heartbeats stays comfortably under the now
// shorter 5-min lease (the extra writes are negligible).
export const CHUNK_HEARTBEAT_INTERVAL_MS = 60_000;

// Source loader retries (Stage 0)
export const SOURCE_LOAD_RETRIES = 5;
export const SOURCE_LOAD_RETRY_DELAY_MS = 500;
