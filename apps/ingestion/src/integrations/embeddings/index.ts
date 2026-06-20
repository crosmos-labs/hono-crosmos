import {
  assertEmbeddingSpace,
  EXPECTED_EMBEDDING_DIMENSIONS,
  OpenAIEmbedder,
  OpenRouterEmbedder,
  WorkersAiEmbedder,
} from '@crosmos/ai';
import type { Embedder } from '@crosmos/ai';
import type { Env } from '../../bindings';

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
  const provider = env.EMBEDDINGS_PROVIDER ?? 'workers-ai';
  // Deployment vector space (= Vectorize index dimension). Must match the API
  // read path. Defaults to 1024 (bge-m3); set EMBEDDING_DIMENSIONS=1536 for
  // native OpenAI text-embedding-3-small.
  const dims = env.EMBEDDING_DIMENSIONS
    ? Number.parseInt(env.EMBEDDING_DIMENSIONS, 10)
    : EXPECTED_EMBEDDING_DIMENSIONS;
  if (provider === 'openai') {
    if (!env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required when EMBEDDINGS_PROVIDER=openai');
    }
    // assertEmbeddingSpace: must match the API read path's provider + the
    // Vectorize index dimension, or retrieval silently breaks. See @crosmos/ai.
    return assertEmbeddingSpace(
      new OpenAIEmbedder({ apiKey: env.OPENAI_API_KEY, dimensions: dims }),
      dims,
    );
  }
  if (provider === 'openrouter') {
    if (!env.OPENROUTER_API_KEY) {
      throw new Error('OPENROUTER_API_KEY is required when EMBEDDINGS_PROVIDER=openrouter');
    }
    return assertEmbeddingSpace(
      new OpenRouterEmbedder({
        apiKey: env.OPENROUTER_API_KEY,
        dimensions: dims,
        appUrl: 'https://crosmos.dev',
        appName: 'Crosmos',
      }),
      dims,
    );
  }
  if (!env.AI) {
    throw new Error('AI binding is required for embeddings (EMBEDDINGS_PROVIDER=workers-ai)');
  }
  return assertEmbeddingSpace(new WorkersAiEmbedder({ ai: env.AI }), dims);
}
