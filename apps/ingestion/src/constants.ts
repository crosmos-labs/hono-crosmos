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
export const STUCK_JOB_TIMEOUT_MINUTES = 10;
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

// Conversation chunking — a source runs entirely in ONE Cloudflare invocation,
// which is bounded to 1000 subrequests; each chunk spends ~6 of them (search
// embed + vector query + 2 LLM calls + batch embed + vector upsert; DB queries
// go over a TCP socket and don't count toward the fetch subrequest cap). A very
// long conversation chunks into many windows and can approach that ceiling. We
// WARN past this threshold for observability; the hard bounds below enforce it.
export const CONVERSATION_CHUNK_WARN_THRESHOLD = 50;

// Per-invocation subrequest budget (issues #1 / #2). A whole job (every source ×
// every chunk) runs in ONE Cloudflare invocation, so the bound is job-wide, not
// per-source. ~6 fetch subrequests per chunk against a ~1000 cap leaves room for
// ~160 chunks; we keep a generous safety margin (entity resolution, status
// writes, heartbeats, estimate error) and cap at 130 chunks per invocation.
export const SUBREQUESTS_PER_CHUNK = 6;
export const MAX_CHUNKS_PER_INVOCATION = 130;
// A SINGLE source must fit in one invocation (it can't be split across them —
// purge re-runs it from the top). A source over this is failed terminally with a
// clear "split it" error rather than silently blowing the subrequest cap. Set
// above the max legal conversation (MAX_CONVERSATION_MESSAGES=500 / segment 4 =
// 125 chunks) so well-formed input never trips it; only abusive/oversized
// sources do. Producer-side splitting of huge conversations is the real fix.
export const MAX_CHUNKS_PER_SOURCE = MAX_CHUNKS_PER_INVOCATION;
// Mid-source lease heartbeat (issue #1). The queue backstop reclaims a job whose
// `started_at` hasn't advanced for JOB_LEASE_MS (10 min). The per-source status
// write only beats BETWEEN sources, so a single long source (many chunks) could
// blow the lease while perfectly healthy and get double-claimed. Re-stamp
// `started_at` mid-source at this cadence — well under the lease, throttled so it
// costs at most a handful of DB writes per long source.
export const CHUNK_HEARTBEAT_INTERVAL_MS = 120_000;

// Source loader retries (Stage 0)
export const SOURCE_LOAD_RETRIES = 5;
export const SOURCE_LOAD_RETRY_DELAY_MS = 500;
