import { OpenAIEmbedder, WorkersAiEmbedder } from '@crosmos/ai';
import type { Embedder } from '@crosmos/ai';
import type { Env } from '../../bindings';

export type { Embedder } from '@crosmos/ai';

/**
 * Embedder for the retrieval read path, selected by `EMBEDDINGS_PROVIDER`:
 *   - `workers-ai` (default) — Cloudflare `@cf/baai/bge-m3` via the `AI`
 *     binding. Edge-native, no external HTTP. 1024-dim.
 *   - `openai` — OpenAI `text-embedding-3-small` (1536-dim). Requires
 *     `OPENAI_API_KEY`. Kept as a fallback; the stored vectors must match the
 *     selected model's dimension (see plan / schema).
 *
 * Both adapters live in `@crosmos/ai` (shared with ingestion); this factory
 * just wires one from env. Thin clients — cheap to construct per request.
 */
export function getEmbedder(env: Env): Embedder {
  const provider = env.EMBEDDINGS_PROVIDER ?? 'workers-ai';
  if (provider === 'openai') {
    if (!env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required when EMBEDDINGS_PROVIDER=openai');
    }
    return new OpenAIEmbedder({ apiKey: env.OPENAI_API_KEY });
  }
  if (!env.AI) {
    throw new Error('AI binding is required for embeddings (EMBEDDINGS_PROVIDER=workers-ai)');
  }
  return new WorkersAiEmbedder({ ai: env.AI });
}
