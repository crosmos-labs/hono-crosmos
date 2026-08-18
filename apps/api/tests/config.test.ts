import { describe, expect, test } from 'bun:test';
import type { Env } from '../src/bindings';
import { getApiConfig } from '../src/config';

function env(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: 'development',
    EMBEDDINGS_PROVIDER: 'workers-ai',
    RERANKER_PROVIDER: 'workers-ai',
    VECTOR_STORE: 'vectorize',
    ...overrides,
  } as Env;
}

describe('API configuration', () => {
  test('parses defaults and couples the slot TTL to the timeout', () => {
    const config = getApiConfig(env({
      RETRIEVAL_TIMEOUT_SECONDS: '20',
      RETRIEVAL_SLOT_TTL_SECONDS: '2',
    }));
    expect(config.limits.retrievalTimeoutSeconds).toBe(20);
    expect(config.limits.retrievalSlotTtlSeconds).toBe(24);
    expect(config.reranker).toEqual({ enabled: true, provider: 'workers-ai' });
  });

  test('returns provider configurations with their required values', () => {
    const config = getApiConfig(env({
      EMBEDDINGS_PROVIDER: 'openai',
      EMBEDDING_DIMENSIONS: '1536',
      OPENAI_API_KEY: 'test-openai',
      VECTOR_STORE: 'qdrant',
      QDRANT_URL: 'https://qdrant.test',
      QDRANT_API_KEY: 'test-qdrant',
      RERANKER_PROVIDER: 'zeroentropy',
      ZEROENTROPY_API_KEY: 'test-reranker',
    }));
    expect(config.embeddings).toMatchObject({ provider: 'openai', dimensions: 1536 });
    expect(config.vectorStore).toMatchObject({ provider: 'qdrant', url: 'https://qdrant.test' });
    expect(config.reranker).toMatchObject({ enabled: true, provider: 'zeroentropy' });
  });

  test('rejects invalid or incomplete selected configurations', () => {
    expect(() => getApiConfig(env({ EMBEDDING_DIMENSIONS: 'NaN' }))).toThrow(
      'EMBEDDING_DIMENSIONS',
    );
    expect(() => getApiConfig(env({ VECTOR_STORE: 'qdrant' }))).toThrow('QDRANT_URL');
    expect(() => getApiConfig(env({ RETRIEVAL_TIMEOUT_SECONDS: '0' }))).toThrow(
      'RETRIEVAL_TIMEOUT_SECONDS',
    );
  });
});
