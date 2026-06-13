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
  // Provider selection. Defaults: workers-ai / vectorize. Must match the API.
  EMBEDDINGS_PROVIDER?: 'workers-ai' | 'openai' | 'openrouter';
  // Deployment vector-space dimension (= Vectorize index dimension). Default
  // 1024 (bge-m3). Set 1536 for native OpenAI text-embedding-3-small. Must
  // match the API worker.
  EMBEDDING_DIMENSIONS?: string;
  VECTOR_STORE?: 'vectorize' | 'pg';

  // Secrets (set via `wrangler secret put` or .dev.vars)
  OPENROUTER_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ZEROENTROPY_API_KEY?: string;
}
