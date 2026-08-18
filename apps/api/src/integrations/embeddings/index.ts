import {
  assertEmbeddingSpace,
  OpenAIEmbedder,
  OpenRouterEmbedder,
  WorkersAiEmbedder,
} from '@crosmos/ai';
import type { Embedder } from '@crosmos/ai';
import type { Env } from '../../bindings';
import { getApiConfig } from '../../config';

export type { Embedder } from '@crosmos/ai';

/** Construct the configured retrieval embedder and enforce its vector dimension. */
export function getEmbedder(env: Env): Embedder {
  const config = getApiConfig(env).embeddings;
  if (config.provider === 'openai') {
    return assertEmbeddingSpace(
      new OpenAIEmbedder({ apiKey: config.apiKey, dimensions: config.dimensions }),
      config.dimensions,
    );
  }
  if (config.provider === 'openrouter') {
    return assertEmbeddingSpace(
      new OpenRouterEmbedder({
        apiKey: config.apiKey,
        dimensions: config.dimensions,
        appUrl: 'https://crosmos.dev',
        appName: 'Crosmos',
      }),
      config.dimensions,
    );
  }
  if (!env.AI) {
    throw new Error('AI binding is required for embeddings (EMBEDDINGS_PROVIDER=workers-ai)');
  }
  return assertEmbeddingSpace(
    new WorkersAiEmbedder({ ai: env.AI }),
    config.dimensions,
  );
}
