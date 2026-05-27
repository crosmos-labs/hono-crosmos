/**
 * Producer-side backpressure constants. Mirror Python's
 * `app/worker/constants.py`; see .codex/pipelines.md. Keep these
 * hard-coded (not env-configurable) so behavior matches between deploys.
 */

/** Reject `POST /sources` with 503 when the queue has at least this many pending jobs. */
export const MAX_QUEUE_DEPTH = 5000;

/** Value of the `Retry-After` response header on 503 (queue full). */
export const RETRY_AFTER_SECONDS = 30;

/** Reject `POST /sources` with 429 when a user already has this many pending+processing jobs. */
export const MAX_PENDING_JOBS_PER_USER = 5000;

/** Producer-side ceiling on request shape. Matches Python `IngestSourcesRequest`. */
export const MAX_SOURCES_PER_REQUEST = 100;
export const MAX_CONTENT_LENGTH_PER_SOURCE = 100_000;

/** Producer-side ceiling on conversation request shape. Matches Python `IngestConversationRequest`. */
export const MAX_CONVERSATION_MESSAGES = 500;

/** Session segmentation — multi-turn ingestion. Matches `ingestion/sessions.py`. */
export const SEGMENT_SIZE = 4;
export const LOOKBACK_WINDOW = 4;
