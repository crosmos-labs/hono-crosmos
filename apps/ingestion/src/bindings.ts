export interface Env {
  // Bindings
  HYPERDRIVE: Hyperdrive;
  // Workers AI — embeddings (bge-m3).
  AI: Ai;
  // Vectorize indexes (used when VECTOR_STORE=vectorize).
  MEMORIES_INDEX: VectorizeIndex;
  ENTITIES_INDEX: VectorizeIndex;

  // Vars
  ENVIRONMENT: 'development' | 'production';
  LLM_PROVIDER: 'openrouter' | 'openai';
  // Provider selection. Defaults: workers-ai / vectorize. Must match the API.
  EMBEDDINGS_PROVIDER?: 'workers-ai' | 'openai';
  VECTOR_STORE?: 'vectorize' | 'pg';

  // Secrets (set via `wrangler secret put` or .dev.vars)
  OPENROUTER_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ZEROENTROPY_API_KEY?: string;
}
