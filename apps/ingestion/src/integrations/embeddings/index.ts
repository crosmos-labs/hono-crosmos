import {
  assertEmbeddingSpace,
  OpenAIEmbedder,
  OpenRouterEmbedder,
  WorkersAiEmbedder,
} from '@crosmos/ai';
import type { Embedder } from '@crosmos/ai';
import type { Env } from '../../bindings';
import { getIngestionConfig } from '../../config';

export type {
  Embedder,
  EmbeddingMode,
  EmbeddingUsage,
  EmbedOptions,
} from '@crosmos/ai';
export { EmbeddingRequestError } from '@crosmos/ai';

/**
 * Embedder for ingestion, selected by `EMBEDDINGS_PROVIDER`:
 *   - `workers-ai` (default) — Cloudflare `@cf/baai/bge-m3` via the `AI`
 *     binding (1024-dim, edge-native).
 *   - `openai` — OpenAI `text-embedding-3-small`, pinned to 1024-dim. Requires
 *     `OPENAI_API_KEY`.
 *   - `openrouter` — `openai/text-embedding-3-small` via OpenRouter, pinned to
 *     1024-dim. Requires `OPENROUTER_API_KEY`.
 *
 * Must match the provider used by the API read path — query and document
 * vectors have to share one vector space.
 */
export function getEmbedder(env: Env): Embedder {
  const config = getIngestionConfig(env).embeddings;
  if (config.provider === 'openai') {
    // assertEmbeddingSpace: must match the API read path's provider + the
    // Vectorize index dimension, or retrieval silently breaks. See @crosmos/ai.
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
