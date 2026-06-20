/**
 * Producer-side backpressure constants. Mirror Python's
 * `app/worker/constants.py`; see .codex/pipelines.md.
 *
 * NOTE: the operational limits below (`MAX_QUEUE_DEPTH`,
 * `MAX_PENDING_JOBS_PER_USER`, `STALE_JOB_MINUTES`) are the DEFAULTS — they're
 * env-overridable via `lib/limits.ts` → `getOperationalLimits` (issue #6).
 * Don't read them directly in request paths; resolve through the config layer so
 * an env override takes effect. The shape/format constants (sizes, lengths) stay
 * compile-time.
 */

/** Reject `POST /sources` with 503 when the queue has at least this many pending jobs. */
export const MAX_QUEUE_DEPTH = 5000;

/** Value of the `Retry-After` response header on 503 (queue full). */
export const RETRY_AFTER_SECONDS = 30;

/** Reject `POST /sources` with 429 when a user already has this many pending+processing jobs. */
export const MAX_PENDING_JOBS_PER_USER = 5000;

/**
 * A job stops counting against the per-user pending cap and the global
 * queue-depth gate once it has been stale this long, and the reaper flips it to
 * `failed` (issue #3). Without this, a worker that died mid-job leaves rows in
 * `processing` forever — they're counted indefinitely and wedge both gates shut
 * until manual cleanup.
 *
 * A healthy `processing` job heartbeats `started_at` once per source (see the
 * ingestion worker's `updateJobStatus`), so it never looks stale; only a job
 * that has made NO progress for this long is treated as orphaned. Kept aligned
 * with the ingestion job lease (`STUCK_JOB_TIMEOUT_MINUTES = 10`) so "abandoned"
 * means the same thing to the gates, the lease/claim, and the reaper.
 */
export const STALE_JOB_MINUTES = 10;

/** Producer-side ceiling on request shape. Matches Python `IngestSourcesRequest`. */
export const MAX_SOURCES_PER_REQUEST = 100;
export const MAX_CONTENT_LENGTH_PER_SOURCE = 100_000;

/**
 * Max source_ids per ingestion JOB. A single request's sources are split into
 * jobs of at most this size, so each worker invocation processes a bounded
 * number of sources and can never exceed Cloudflare's per-invocation subrequest
 * cap (each source makes several LLM/embed/vector subrequests — more so for
 * fetch-based vector stores like Qdrant, where every op is a counted
 * subrequest). One job == one invocation under the claim/lease model — and on a
 * backstop RECLAIM a single invocation re-runs ALL of a job's not-yet-terminal
 * sources at once — so this is the true per-invocation ceiling regardless of
 * how the client batches.
 *
 * Sizing: measured ~50 subrequests/source (≈2 LLM + 3 embed + ~4 Qdrant + DB
 * queries over Hyperdrive); the Workers Paid per-invocation cap is 1000. A
 * reclaim of a 25-source job hit the cap at ~source 19, so we set this to 10
 * (~500 subrequests/invocation — a 2× margin that absorbs content-heavy
 * sources with extra memories/entities).
 */
export const MAX_SOURCES_PER_JOB = 10;

/** Producer-side ceiling on conversation request shape. Matches Python `IngestConversationRequest`. */
export const MAX_CONVERSATION_MESSAGES = 500;

/** Session segmentation — multi-turn ingestion. Matches `ingestion/sessions.py`. */
export const SEGMENT_SIZE = 4;
export const LOOKBACK_WINDOW = 4;
