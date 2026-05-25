export interface Env {
  // Bindings
  HYPERDRIVE: Hyperdrive;
  API_KEY_CACHE: KVNamespace;
  INGESTION_QUEUE: Queue;

  // Vars
  ENVIRONMENT: 'development' | 'production';
  OAUTH_SERVER_BASE_URL: string;
  APP_BASE_URL: string;

  // Secrets (set via `wrangler secret put` or .dev.vars)
  JWT_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  RESEND_API_KEY: string;
  SENTRY_DSN: string;
  POLAR_WEBHOOK_SECRET: string;
  // Retrieval (read path) — embedder + cross-encoder reranker.
  OPENAI_API_KEY?: string;
  ZEROENTROPY_API_KEY?: string;
  // Toggles the cross-encoder reranker. Anything other than "false" keeps it
  // on (default on). Mirrors Python's RETRIEVAL_RERANKER_ENABLED.
  RETRIEVAL_RERANKER_ENABLED?: string;
}

// Variables Hono sets on the request context (populated by middleware).
export interface Variables {
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
