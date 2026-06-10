export interface Env {
  // Bindings
  HYPERDRIVE: Hyperdrive;
  API_KEY_CACHE: KVNamespace;
  INGESTION_QUEUE: Queue;
  // Workers AI — embeddings (bge-m3) + cross-encoder reranker (bge-reranker-base).
  AI: Ai;
  // Vectorize indexes (used when VECTOR_STORE=vectorize).
  MEMORIES_INDEX: VectorizeIndex;
  ENTITIES_INDEX: VectorizeIndex;

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
  // Provider selection. Defaults: workers-ai / workers-ai / vectorize.
  EMBEDDINGS_PROVIDER?: 'workers-ai' | 'openai';
  RERANKER_PROVIDER?: 'workers-ai' | 'zeroentropy';
  VECTOR_STORE?: 'vectorize' | 'pg';
  // Only needed for the non-default (fallback) providers.
  OPENAI_API_KEY?: string;
  ZEROENTROPY_API_KEY?: string;
  // Toggles the cross-encoder reranker. Anything other than "false" keeps it
  // on (default on). Mirrors Python's RETRIEVAL_RERANKER_ENABLED.
  RETRIEVAL_RERANKER_ENABLED?: string;
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
}

export type HonoEnv = {
  Bindings: Env;
  Variables: Variables;
};
