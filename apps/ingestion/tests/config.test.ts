import { describe, expect, test } from 'bun:test';
import type { Env } from '../src/bindings';
import { getIngestionConfig } from '../src/config';

function env(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: 'development',
    LLM_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: 'test-openrouter',
    EMBEDDINGS_PROVIDER: 'workers-ai',
    VECTOR_STORE: 'vectorize',
    ...overrides,
  } as Env;
}

describe('ingestion configuration', () => {
  test('parses one typed provider configuration', () => {
    const config = getIngestionConfig(env({
      LLM_PROVIDER: 'openai',
      OPENAI_API_KEY: 'test-openai',
      EMBEDDINGS_PROVIDER: 'openai',
      EMBEDDING_DIMENSIONS: '1536',
      VECTOR_STORE: 'qdrant',
      QDRANT_URL: 'https://qdrant.test',
      QDRANT_API_KEY: 'test-qdrant',
    }));
    expect(config.llm.provider).toBe('openai');
    expect(config.embeddings).toMatchObject({ provider: 'openai', dimensions: 1536 });
    expect(config.vectorStore).toMatchObject({ provider: 'qdrant', url: 'https://qdrant.test' });
  });

  test('rejects a selected provider without its requirements', () => {
    expect(() => getIngestionConfig(env({ LLM_PROVIDER: 'openai' }))).toThrow(
      'OPENAI_API_KEY',
    );
    expect(() => getIngestionConfig(env({ EMBEDDING_DIMENSIONS: '0' }))).toThrow(
      'EMBEDDING_DIMENSIONS',
    );
  });
});
