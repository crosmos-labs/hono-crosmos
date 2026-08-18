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

/**
 * Embedder for the retrieval read path, selected by `EMBEDDINGS_PROVIDER`:
 *   - `workers-ai` (default) — Cloudflare `@cf/baai/bge-m3` via the `AI`
 *     binding. Edge-native, no external HTTP. 1024-dim.
 *   - `openai` — OpenAI `text-embedding-3-small`, pinned to 1024-dim (the
 *     Vectorize index dimension) via the `dimensions` param. Requires
 *     `OPENAI_API_KEY`. External HTTP from the (Singapore-placed) worker.
 *   - `openrouter` — `openai/text-embedding-3-small` via the OpenRouter
 *     gateway, also pinned to 1024-dim. Requires `OPENROUTER_API_KEY`.
 *
 * For openai/openrouter the stored document vectors must come from the SAME
 * provider+model (see assertEmbeddingSpace / EXPECTED_EMBEDDING_DIMENSIONS),
 * or retrieval ranking is meaningless even though the call succeeds.
 *
 * Both adapters live in `@crosmos/ai` (shared with ingestion); this factory
 * just wires one from env. Thin clients — cheap to construct per request.
 */
export function getEmbedder(env: Env): Embedder {
  const config = getApiConfig(env).embeddings;
  if (config.provider === 'openai') {
    // assertEmbeddingSpace: must match ingestion's provider + the Vectorize
    // index dimension, or retrieval silently breaks. See @crosmos/ai.
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
