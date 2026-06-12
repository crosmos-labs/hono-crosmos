import {
  assertEmbeddingSpace,
  OpenAIEmbedder,
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
 *   - `openai` — OpenAI `text-embedding-3-small` (1536-dim), requires
 *     `OPENAI_API_KEY`.
 *
 * Must match the provider used by the API read path — query and document
 * vectors have to share one vector space.
 */
export function getEmbedder(env: Env): Embedder {
  const provider = env.EMBEDDINGS_PROVIDER ?? 'workers-ai';
  if (provider === 'openai') {
    if (!env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required when EMBEDDINGS_PROVIDER=openai');
    }
    // assertEmbeddingSpace: must match the API read path's provider + the
    // Vectorize index dimension, or retrieval silently breaks. See @crosmos/ai.
    return assertEmbeddingSpace(new OpenAIEmbedder({ apiKey: env.OPENAI_API_KEY }));
  }
  if (!env.AI) {
    throw new Error('AI binding is required for embeddings (EMBEDDINGS_PROVIDER=workers-ai)');
  }
  return assertEmbeddingSpace(new WorkersAiEmbedder({ ai: env.AI }));
}
