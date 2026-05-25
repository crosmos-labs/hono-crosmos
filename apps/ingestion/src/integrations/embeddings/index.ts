import { OpenAIEmbedder } from '@crosmos/ai';
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
 * Returns the configured embedder for this environment. The OpenAI
 * `text-embedding-3-small` adapter now lives in `@crosmos/ai` (shared with
 * the retrieval read path); this factory just wires it from env secrets.
 */
export function getEmbedder(env: Env): Embedder {
  if (!env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required for embeddings');
  }
  return new OpenAIEmbedder({ apiKey: env.OPENAI_API_KEY });
}
