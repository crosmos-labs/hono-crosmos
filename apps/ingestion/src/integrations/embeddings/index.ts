import type { Env } from '../../bindings';
import { OpenAIEmbedder } from './openai';
import type { Embedder } from './port';

export type { Embedder, EmbeddingMode, EmbeddingUsage, EmbedOptions } from './port';
export { EmbeddingRequestError } from './openai';

/**
 * Returns the configured embedder for this environment. Today the only
 * implementation is OpenAI `text-embedding-3-small`. Adding another provider
 * (Cohere, Voyage) means: drop a new `./<provider>.ts` adapter, expose a new
 * `EMBEDDING_PROVIDER` env var, and branch here — every other file stays put.
 */
export function getEmbedder(env: Env): Embedder {
  if (!env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required for embeddings');
  }
  return new OpenAIEmbedder({ apiKey: env.OPENAI_API_KEY });
}
