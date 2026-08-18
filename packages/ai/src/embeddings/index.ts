import type { Embedder } from './port';

export type {
  Embedder,
  EmbeddingMode,
  EmbeddingUsage,
  EmbedOptions,
} from './port';
export { EmbeddingRequestError } from './openai-compat';
export { OpenAICompatEmbedder } from './openai-compat';
export type { OpenAICompatEmbedderConfig } from './openai-compat';
export { OpenAIEmbedder } from './openai';
export type { OpenAIEmbedderConfig } from './openai';
export { OpenRouterEmbedder } from './openrouter';
export type { OpenRouterEmbedderConfig } from './openrouter';
export { WorkersAiEmbedder } from './workers-ai';
export type { WorkersAiEmbedderConfig } from './workers-ai';

/** Fallback dimension for callers that do not supply deployment configuration. */
export const EXPECTED_EMBEDDING_DIMENSIONS = 1024;

/**
 * Fail-fast guardrail for the invariant above. Each worker's embedder factory
 * routes its constructed embedder through this, so a misconfigured
 * EMBEDDINGS_PROVIDER throws a clear error at construction time instead of
 * silently returning garbage search results.
 *
 * Production callers pass their validated configured dimension explicitly;
 * the default exists for adapter-level and local callers only.
 */
export function assertEmbeddingSpace(
  embedder: Embedder,
  expected: number = EXPECTED_EMBEDDING_DIMENSIONS,
): Embedder {
  if (embedder.dimensions !== expected) {
    throw new Error(
      `Embedding dimension mismatch: the configured embedder produces ` +
        `${embedder.dimensions}-dim vectors, but this deployment's vector space is ` +
        `${expected}-dim. Ingestion ` +
        `and retrieval must use the same embedding model. If you are intentionally ` +
        `switching models, update both workers and their vector indexes together, ` +
        `then re-embed all sources.`,
    );
  }
  return embedder;
}
