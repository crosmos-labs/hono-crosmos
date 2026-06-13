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

/**
 * Canonical embedding dimensionality for this deployment — the dimension the
 * Vectorize indexes (`crosmos-memories` / `crosmos-entities`) were created with
 * (`--dimensions=1024`), and the single geometric space every stored document
 * vector and every query vector must live in.
 *
 * THE INVARIANT: ingestion (writes document vectors) and the API read path
 * (embeds queries) must embed into the SAME space, so both workers must run an
 * embedder whose `.dimensions` equals this value. Mixing providers — e.g.
 * ingest with workers-ai bge-m3 (1024) but retrieve with openai
 * text-embedding-3-small (1536) — silently destroys retrieval: cosine
 * similarity across two spaces is meaningless, and Vectorize rejects
 * wrong-dimension vectors outright. The two workers can't see each other's
 * config at runtime, so each pins to this shared constant instead.
 *
 * To migrate embedding models you must, together: flip both workers'
 * EMBEDDINGS_PROVIDER, update this constant, recreate the Vectorize indexes at
 * the new dimension, and re-embed all existing sources.
 */
export const EXPECTED_EMBEDDING_DIMENSIONS = 1024;

/**
 * Fail-fast guardrail for the invariant above. Each worker's embedder factory
 * routes its constructed embedder through this, so a misconfigured
 * EMBEDDINGS_PROVIDER throws a clear error at construction time instead of
 * silently returning garbage search results.
 *
 * `expected` defaults to {@link EXPECTED_EMBEDDING_DIMENSIONS} but can be
 * overridden by a deployment that pins a different vector space via an env var
 * (e.g. `EMBEDDING_DIMENSIONS=1536` for native OpenAI `text-embedding-3-small`,
 * with the Vectorize indexes recreated at that dimension). BOTH workers must
 * agree on the value, or query and document vectors won't share a space.
 */
export function assertEmbeddingSpace(
  embedder: Embedder,
  expected: number = EXPECTED_EMBEDDING_DIMENSIONS,
): Embedder {
  if (embedder.dimensions !== expected) {
    throw new Error(
      `Embedding dimension mismatch: the configured embedder produces ` +
        `${embedder.dimensions}-dim vectors, but this deployment's vector space is ` +
        `${expected}-dim (the Vectorize index dimension). Ingestion ` +
        `and retrieval must use the same embedding model. If you are intentionally ` +
        `switching models, set EMBEDDING_DIMENSIONS on BOTH workers, recreate the Vectorize ` +
        `indexes at the new dimension, and re-embed all sources.`,
    );
  }
  return embedder;
}
