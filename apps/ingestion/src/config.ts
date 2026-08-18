import { EXPECTED_EMBEDDING_DIMENSIONS } from '@crosmos/ai';
import {
  parseDeploymentEnvironment,
  parseEnum,
  parseInteger,
  requireConfig,
  type DeploymentEnvironment,
} from '@crosmos/runtime';
import type { Env } from './bindings';

type LlmConfig =
  | { provider: 'openai'; apiKey: string }
  | { provider: 'openrouter'; apiKey: string };

type EmbeddingConfig =
  | { provider: 'workers-ai'; dimensions: number }
  | { provider: 'openai'; dimensions: number; apiKey: string }
  | { provider: 'openrouter'; dimensions: number; apiKey: string };

type VectorStoreConfig =
  | { provider: 'pg' }
  | { provider: 'vectorize' }
  | {
      provider: 'qdrant';
      url: string;
      apiKey: string;
      memoriesCollection: string;
      entitiesCollection: string;
    };

export interface IngestionConfig {
  environment: DeploymentEnvironment;
  llm: LlmConfig;
  embeddings: EmbeddingConfig;
  vectorStore: VectorStoreConfig;
}

const cache = new WeakMap<Env, IngestionConfig>();

export function getIngestionConfig(env: Env): IngestionConfig {
  const cached = cache.get(env);
  if (cached) return cached;

  const llmProvider = parseEnum(
    env.LLM_PROVIDER,
    'LLM_PROVIDER',
    ['openrouter', 'openai'] as const,
    'openrouter',
  );
  const llm: LlmConfig = llmProvider === 'openai'
    ? { provider: 'openai', apiKey: requireConfig(env.OPENAI_API_KEY, 'OPENAI_API_KEY') }
    : { provider: 'openrouter', apiKey: requireConfig(env.OPENROUTER_API_KEY, 'OPENROUTER_API_KEY') };

  const dimensions = parseInteger(
    env.EMBEDDING_DIMENSIONS,
    'EMBEDDING_DIMENSIONS',
    EXPECTED_EMBEDDING_DIMENSIONS,
    { min: 1, max: 4096 },
  );
  const embeddingProvider = parseEnum(
    env.EMBEDDINGS_PROVIDER,
    'EMBEDDINGS_PROVIDER',
    ['workers-ai', 'openai', 'openrouter'] as const,
    'workers-ai',
  );
  const embeddings: EmbeddingConfig = embeddingProvider === 'openai'
    ? { provider: 'openai', dimensions, apiKey: requireConfig(env.OPENAI_API_KEY, 'OPENAI_API_KEY') }
    : embeddingProvider === 'openrouter'
      ? { provider: 'openrouter', dimensions, apiKey: requireConfig(env.OPENROUTER_API_KEY, 'OPENROUTER_API_KEY') }
      : { provider: 'workers-ai', dimensions };

  const vectorProvider = parseEnum(
    env.VECTOR_STORE,
    'VECTOR_STORE',
    ['vectorize', 'pg', 'qdrant'] as const,
    'vectorize',
  );
  const vectorStore: VectorStoreConfig = vectorProvider === 'qdrant'
    ? {
        provider: 'qdrant',
        url: requireConfig(env.QDRANT_URL, 'QDRANT_URL'),
        apiKey: requireConfig(env.QDRANT_API_KEY, 'QDRANT_API_KEY'),
        memoriesCollection: env.QDRANT_MEMORIES_COLLECTION ?? 'crosmos-memories',
        entitiesCollection: env.QDRANT_ENTITIES_COLLECTION ?? 'crosmos-entities',
      }
    : { provider: vectorProvider };

  const config: IngestionConfig = {
    environment: parseDeploymentEnvironment(env.ENVIRONMENT),
    llm,
    embeddings,
    vectorStore,
  };
  cache.set(env, config);
  return config;
}
