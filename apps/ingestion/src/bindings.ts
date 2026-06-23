export interface Env {
  // Bindings
  HYPERDRIVE: Hyperdrive;
  // Workers AI — embeddings (bge-m3).
  AI: Ai;
  // Vectorize indexes (used when VECTOR_STORE=vectorize).
  MEMORIES_INDEX: VectorizeIndex;
  ENTITIES_INDEX: VectorizeIndex;
  // Analytics Engine — metrics sink (ingestion outcome/latency/tokens).
  // Optional: unbound in local dev / tests, where createMetrics() is a no-op.
  ANALYTICS?: AnalyticsEngineDataset;

  // Vars
  ENVIRONMENT: 'development' | 'production';
  LLM_PROVIDER: 'openrouter' | 'openai';
  // Code-fallback defaults if unset: workers-ai / vectorize. PRODUCTION runs
  // openai / qdrant (see docs/deployed-architecture.md and [env.production.vars]);
  // the Workers AI + Vectorize bindings are DORMANT in prod. Must match the API.
  EMBEDDINGS_PROVIDER?: 'workers-ai' | 'openai' | 'openrouter';
  // Deployment vector-space dimension (= Vectorize index dimension). Default
  // 1024 (bge-m3). Set 1536 for native OpenAI text-embedding-3-small. Must
  // match the API worker.
  EMBEDDING_DIMENSIONS?: string;
  VECTOR_STORE?: 'vectorize' | 'pg' | 'qdrant';
  // Qdrant config (only needed when VECTOR_STORE=qdrant). Collection names
  // default to crosmos-memories/crosmos-entities if unset. Must match the API.
  QDRANT_URL?: string;
  QDRANT_API_KEY?: string;
  QDRANT_MEMORIES_COLLECTION?: string;
  QDRANT_ENTITIES_COLLECTION?: string;

  // Secrets (set via `wrangler secret put` or .dev.vars)
  OPENROUTER_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ZEROENTROPY_API_KEY?: string;
}
