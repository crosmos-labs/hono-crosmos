import type { IngestionJobMessage } from '@crosmos/types';
import type { DeploymentEnvironment } from '@crosmos/runtime';

export interface Env {
  // Bindings
  CF_VERSION_METADATA?: { id: string; tag: string; timestamp: string };
  HYPERDRIVE: Hyperdrive;
  /**
   * Producer binding onto the SAME queue this worker consumes. Used only to
   * publish *continuations* — a job that advanced its durable checkpoints but
   * ran out of per-invocation chunk budget gets a fresh message (attempt
   * counter reset) instead of burning the delivery retry budget meant for
   * failures. See `MAX_JOB_CONTINUATIONS` and `queue-consumer.ts`.
   *
   * Optional so the consumer degrades to the old re-queue behavior in local dev
   * or any deployment where the binding hasn't been added yet.
   */
  INGESTION_QUEUE?: Queue<IngestionJobMessage>;
  // Workers AI — embeddings (bge-m3).
  AI: Ai;
  // Optional: only bound where VECTOR_STORE=vectorize. Staging and production
  // run Qdrant, and wrangler validates Vectorize bindings at deploy time even
  // when nothing reads them, so those envs declare none. `getVectorStore`
  // throws a clear error if the backend is switched back without them.
  MEMORIES_INDEX?: VectorizeIndex;
  ENTITIES_INDEX?: VectorizeIndex;
  // Analytics Engine — metrics sink (ingestion outcome/latency/tokens). Bound
  // in every deployed environment since 2026-08-11; still optional because
  // `bun test` and direct library use have no binding, where `createMetrics`
  // degrades to a silent no-op. See docs/metrics-runbook.md.
  ANALYTICS?: AnalyticsEngineDataset;

  // Vars
  ENVIRONMENT: DeploymentEnvironment;
  LLM_PROVIDER?: 'openrouter' | 'openai';
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
}
