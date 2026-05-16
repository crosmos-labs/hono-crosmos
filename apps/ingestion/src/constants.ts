/**
 * Pipeline-wide constants. Mirrors the Python `app/engine/extractors/constants.py`,
 * `app/engine/extractors/resolve_entity.py`, `app/engine/extractors/dedup_helpers.py`,
 * `app/worker/constants.py`, and `app/engine/ingestion/sessions.py`.
 *
 * Hard-coded, not env-configurable — Python treats them as code. See
 * docs/ingestion_migration/README.md §Critical Numbers.
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

// Session ingestion
export const SESSION_SEGMENT_SIZE = 4;
export const SESSION_LOOKBACK_WINDOW = 4;

// Source loader retries (Stage 0)
export const SOURCE_LOAD_RETRIES = 5;
export const SOURCE_LOAD_RETRY_DELAY_MS = 500;
