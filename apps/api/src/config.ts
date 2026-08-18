import {
  parseBoolean,
  parseDeploymentEnvironment,
  parseEnum,
  parseInteger,
  requireConfig,
  type DeploymentEnvironment,
} from '@crosmos/runtime';
import { EXPECTED_EMBEDDING_DIMENSIONS } from '@crosmos/ai';
import type { Env } from './bindings';
import {
  MAX_PENDING_JOBS_PER_USER,
  MAX_QUEUE_DEPTH,
  STALE_JOB_MINUTES,
} from './features/sources/constants';
import {
  GLOBAL_AI_RPM_CEILING,
  RETRIEVAL_MAX_CONCURRENT_PER_USER,
  RETRIEVAL_RESULT_TIMEOUT_SECONDS,
  RETRIEVAL_SLOT_TTL_GRACE_SECONDS,
} from './features/search/constants';

const RETENTION_DEFAULTS = {
  revokedTokens: 30,
  ingestionJobs: 90,
  billingEvents: 180,
  dailyUsage: 400,
} as const;

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

type RerankerConfig =
  | { enabled: false }
  | { enabled: true; provider: 'workers-ai' }
  | { enabled: true; provider: 'zeroentropy'; apiKey?: string }
  | {
      enabled: true;
      provider: 'voyage';
      apiKey?: string;
      model: 'rerank-2.5' | 'rerank-2.5-lite';
    };

export interface ApiConfig {
  environment: DeploymentEnvironment;
  embeddings: EmbeddingConfig;
  vectorStore: VectorStoreConfig;
  reranker: RerankerConfig;
  limits: OperationalLimits;
  billingGracePeriodDays: number;
  retentionDays: RetentionDays;
  spaceFinalizerEnabled: boolean;
  debugErrors: boolean;
}

export interface OperationalLimits {
  maxPendingJobsPerUser: number;
  maxQueueDepth: number;
  staleJobMinutes: number;
  retrievalMaxConcurrentPerUser: number;
  globalAiRpmCeiling: number;
  retrievalTimeoutSeconds: number;
  retrievalSlotTtlSeconds: number;
}

interface RetentionDays {
  revokedTokens: number;
  ingestionJobs: number;
  billingEvents: number;
  dailyUsage: number;
}

const cache = new WeakMap<Env, ApiConfig>();

export function getApiConfig(env: Env): ApiConfig {
  const cached = cache.get(env);
  if (cached) return cached;

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

  const rerankerEnabled = parseBoolean(
    env.RETRIEVAL_RERANKER_ENABLED,
    'RETRIEVAL_RERANKER_ENABLED',
    true,
  );
  const rerankerProvider = parseEnum(
    env.RERANKER_PROVIDER,
    'RERANKER_PROVIDER',
    ['workers-ai', 'zeroentropy', 'voyage'] as const,
    'workers-ai',
  );
  const reranker: RerankerConfig = !rerankerEnabled
    ? { enabled: false }
    : rerankerProvider === 'zeroentropy'
      ? { enabled: true, provider: 'zeroentropy', apiKey: env.ZEROENTROPY_API_KEY }
      : rerankerProvider === 'voyage'
        ? {
            enabled: true,
            provider: 'voyage',
            apiKey: env.VOYAGE_API_KEY,
            model: parseEnum(
              env.VOYAGE_RERANKER_MODEL,
              'VOYAGE_RERANKER_MODEL',
              ['rerank-2.5', 'rerank-2.5-lite'] as const,
              'rerank-2.5',
            ),
          }
        : { enabled: true, provider: 'workers-ai' };

  const retrievalTimeoutSeconds = parseInteger(
    env.RETRIEVAL_TIMEOUT_SECONDS,
    'RETRIEVAL_TIMEOUT_SECONDS',
    RETRIEVAL_RESULT_TIMEOUT_SECONDS,
    { min: 1 },
  );
  const minSlotTtl = retrievalTimeoutSeconds + RETRIEVAL_SLOT_TTL_GRACE_SECONDS;
  const limits: OperationalLimits = {
    maxPendingJobsPerUser: parseInteger(env.MAX_PENDING_JOBS_PER_USER, 'MAX_PENDING_JOBS_PER_USER', MAX_PENDING_JOBS_PER_USER, { min: 1 }),
    maxQueueDepth: parseInteger(env.MAX_QUEUE_DEPTH, 'MAX_QUEUE_DEPTH', MAX_QUEUE_DEPTH, { min: 1 }),
    staleJobMinutes: parseInteger(env.STALE_JOB_MINUTES, 'STALE_JOB_MINUTES', STALE_JOB_MINUTES, { min: 1 }),
    retrievalMaxConcurrentPerUser: parseInteger(env.RETRIEVAL_MAX_CONCURRENT_PER_USER, 'RETRIEVAL_MAX_CONCURRENT_PER_USER', RETRIEVAL_MAX_CONCURRENT_PER_USER, { min: 1 }),
    globalAiRpmCeiling: parseInteger(env.GLOBAL_AI_RPM_CEILING, 'GLOBAL_AI_RPM_CEILING', GLOBAL_AI_RPM_CEILING, { min: 1 }),
    retrievalTimeoutSeconds,
    retrievalSlotTtlSeconds: Math.max(
      minSlotTtl,
      parseInteger(env.RETRIEVAL_SLOT_TTL_SECONDS, 'RETRIEVAL_SLOT_TTL_SECONDS', minSlotTtl, { min: 1 }),
    ),
  };

  const config: ApiConfig = {
    environment: parseDeploymentEnvironment(env.ENVIRONMENT),
    embeddings,
    vectorStore,
    reranker,
    limits,
    billingGracePeriodDays: parseInteger(env.BILLING_GRACE_PERIOD_DAYS, 'BILLING_GRACE_PERIOD_DAYS', 7, { min: 0 }),
    retentionDays: {
      revokedTokens: parseInteger(env.REVOKED_TOKEN_RETENTION_DAYS, 'REVOKED_TOKEN_RETENTION_DAYS', RETENTION_DEFAULTS.revokedTokens, { min: 1 }),
      ingestionJobs: parseInteger(env.INGESTION_JOB_RETENTION_DAYS, 'INGESTION_JOB_RETENTION_DAYS', RETENTION_DEFAULTS.ingestionJobs, { min: 1 }),
      billingEvents: parseInteger(env.BILLING_EVENT_RETENTION_DAYS, 'BILLING_EVENT_RETENTION_DAYS', RETENTION_DEFAULTS.billingEvents, { min: 1 }),
      dailyUsage: parseInteger(env.DAILY_USAGE_RETENTION_DAYS, 'DAILY_USAGE_RETENTION_DAYS', RETENTION_DEFAULTS.dailyUsage, { min: 1 }),
    },
    spaceFinalizerEnabled: parseBoolean(env.SPACE_FINALIZER_ENABLED, 'SPACE_FINALIZER_ENABLED', false),
    debugErrors: parseBoolean(env.DEBUG_ERRORS, 'DEBUG_ERRORS', false),
  };
  cache.set(env, config);
  return config;
}
