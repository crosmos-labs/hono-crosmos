import type { IngestionJobMessage } from '@crosmos/types';

/**
 * RPC surface of the ingestion worker (apps/ingestion `IngestionWorker`),
 * reached over a service binding. `ingest` is the low-latency fast path: it
 * starts the job immediately instead of waiting out Cloudflare Queues'
 * cold-queue delivery delay. Fire-and-forget — the durable queue copy is the
 * backstop, so callers should invoke this via `waitUntil` and never block on it.
 */
export interface IngestionRpc {
  ingest(message: IngestionJobMessage): Promise<void>;
}

export interface Env {
  // Bindings
  HYPERDRIVE: Hyperdrive;
  API_KEY_CACHE: KVNamespace;
  INGESTION_QUEUE: Queue;
  // Service binding to the ingestion worker — direct RPC fast path that
  // sidesteps queue delivery latency. INGESTION_QUEUE remains the backstop.
  // Typed as the RPC surface only (not `Service<typeof IngestionWorker>`) to
  // avoid coupling apps/api to apps/ingestion source — same stance as the
  // job-store mirror. The runtime stub also exposes fetch/connect; unused here.
  INGESTION_SERVICE: IngestionRpc;
  // Workers AI — embeddings (bge-m3) + cross-encoder reranker (bge-reranker-base).
  AI: Ai;
  // Vectorize indexes (used when VECTOR_STORE=vectorize).
  MEMORIES_INDEX: VectorizeIndex;
  ENTITIES_INDEX: VectorizeIndex;
  // Analytics Engine — metrics sink (counters/latencies). Optional: unbound in
  // local dev / tests, where createMetrics() degrades to a no-op.
  ANALYTICS?: AnalyticsEngineDataset;
  // Durable-Object rate limiter (class RateLimiterDO) for per-IP limits on
  // pre-org-context auth/OAuth routes (see integrations/rate-limit/ip.ts).
  // Optional: unbound in local dev, where the limiter fails open.
  RATE_LIMITER?: DurableObjectNamespace;

  // Vars
  ENVIRONMENT: 'development' | 'production';
  OAUTH_SERVER_BASE_URL: string;
  APP_BASE_URL: string;

  // Secrets (set via `wrangler secret put` or .dev.vars)
  JWT_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  RESEND_API_KEY: string;
  RESEND_FROM_ADDRESS?: string;
  INVITE_ACCEPT_URL?: string;
  POLAR_ACCESS_TOKEN: string;
  POLAR_WEBHOOK_SECRET: string;
  POLAR_ENVIRONMENT?: 'sandbox' | 'production';
  POLAR_PRODUCT_ID_DEVELOPER?: string;
  POLAR_PRODUCT_ID_PRO?: string;
  BILLING_SUCCESS_URL?: string;
  BILLING_CANCEL_URL?: string;
  BILLING_METADATA_SECRET?: string;
  BILLING_GRACE_PERIOD_DAYS?: string;
  // Retrieval (read path) — embedder + cross-encoder reranker.
  // Code-fallback defaults if the var is unset: workers-ai / workers-ai / vectorize.
  // PRODUCTION runs openai / zeroentropy / qdrant (see docs/deployed-architecture.md
  // and [env.production.vars] in wrangler.toml). The Workers AI + Vectorize bindings
  // are declared but DORMANT in prod — these vars route around them.
  EMBEDDINGS_PROVIDER?: 'workers-ai' | 'openai' | 'openrouter';
  RERANKER_PROVIDER?: 'workers-ai' | 'zeroentropy';
  VECTOR_STORE?: 'vectorize' | 'pg' | 'qdrant';
  // Qdrant config (only needed when VECTOR_STORE=qdrant). Collection names
  // default to crosmos-memories/crosmos-entities if unset.
  QDRANT_URL?: string;
  QDRANT_API_KEY?: string;
  QDRANT_MEMORIES_COLLECTION?: string;
  QDRANT_ENTITIES_COLLECTION?: string;
  // Deployment vector-space dimension (= Vectorize index dimension). Default
  // 1024 (bge-m3). Set 1536 for native OpenAI text-embedding-3-small (indexes
  // must be recreated at that dimension). Must match the ingestion worker.
  EMBEDDING_DIMENSIONS?: string;
  // Only needed for the non-default (fallback) providers.
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  ZEROENTROPY_API_KEY?: string;
  // Toggles the cross-encoder reranker. Anything other than "false" keeps it
  // on (default on). Mirrors Python's RETRIEVAL_RERANKER_ENABLED.
  RETRIEVAL_RERANKER_ENABLED?: string;
  // Gates the temporary /api/v1/_admin/reembed ops tool (off unless "true").
  ADMIN_TOOLS?: string;

  // Operational limits (issue #6) — env overrides for the admission/backpressure
  // knobs. Optional: each falls back to its compile-time default (see
  // lib/limits.ts → getOperationalLimits). Integers as strings.
  MAX_PENDING_JOBS_PER_USER?: string;
  MAX_QUEUE_DEPTH?: string;
  STALE_JOB_MINUTES?: string;
  RETRIEVAL_MAX_CONCURRENT_PER_USER?: string;
  GLOBAL_AI_RPM_CEILING?: string;
}

// Variables Hono sets on the request context (populated by middleware).
export interface Variables {
  requestId?: string;
  // Set after auth middleware
  userId?: number;
  userUuid?: string;
  userEmail?: string;
  userName?: string;
  authMethod?: 'jwt' | 'api_key';
  // Org context (set by org middleware or carried by API key)
  activeOrgId?: number;
  activeOrgUuid?: string;
  orgRole?: 'owner' | 'admin' | 'member';
  // API key info, if auth was via API key
  apiKeyId?: number;
  apiKeyUuid?: string;
  // If the authenticating API key is space-scoped, its pinned space id. The
  // data-plane gates (ingest/search/sources) reject any other space. Undefined
  // for JWT auth or org-wide keys (no scoping).
  scopedSpaceId?: number;
  // Set once the strict AI-path plan rate limit has been enforced for this
  // request (search/ingest gates), so route-level enforcement doesn't
  // double-count.
  planRateLimitEnforced?: boolean;
  // Set once the looser default-on management rate limit has been enforced by
  // `requireAuth`, guarding against a double-count if it ever runs twice.
  mgmtRateLimitEnforced?: boolean;
}

export type HonoEnv = {
  Bindings: Env;
  Variables: Variables;
};
