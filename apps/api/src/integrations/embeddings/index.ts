import { OpenAIEmbedder } from '@crosmos/ai';
import type { Embedder } from '@crosmos/ai';
import type { Env } from '../../bindings';

export type { Embedder } from '@crosmos/ai';

/**
 * Embedder for the retrieval read path. The OpenAI `text-embedding-3-small`
 * adapter lives in `@crosmos/ai` (shared with ingestion); this factory wires
 * it from env. Thin HTTP client — cheap to construct per request.
 */
export function getEmbedder(env: Env): Embedder {
  if (!env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required for embeddings');
  }
  return new OpenAIEmbedder({ apiKey: env.OPENAI_API_KEY });
}
