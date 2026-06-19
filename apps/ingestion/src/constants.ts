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
export const EMBEDDING_DIMENSIONS = 1536;
export const MIN_IMPORTANCE_SCORE = 0.2;
export const MIN_RELATION_CONFIDENCE = 0.7;

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

// Conversation chunking — a source runs entirely in ONE Cloudflare invocation,
// which is bounded to 1000 subrequests; each chunk spends ~10 of them (search
// embed + 2 LLM calls + batch embed + DB + vector ops). A very long conversation
// chunks into many windows and can approach that ceiling. We only WARN past this
// threshold today (see the TODO in pipeline.ts); production bounding (splitting
// a long conversation across sources/jobs) is a follow-up.
export const CONVERSATION_CHUNK_WARN_THRESHOLD = 50;

// Source loader retries (Stage 0)
export const SOURCE_LOAD_RETRIES = 5;
export const SOURCE_LOAD_RETRY_DELAY_MS = 500;
