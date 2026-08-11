/**
 * Embedding provider — the interface callers use for memory, entity, and
 * query vectors.
 *
 * The default provider (Cloudflare `@cf/baai/bge-m3`) returns 1024-dim vectors,
 * matching `vector(1024)` on `memories.embedding` and `entities.embedding`. If
 * you switch to a model with a different dimension (e.g. the OpenAI fallback at
 * 1536), the DB columns / Vectorize index dimension must change too.
 *
 * `mode` distinguishes asymmetric retrieval models (one vector space for
 * documents, another for queries). For both bge-m3 and OpenAI
 * `text-embedding-3-small` the modes share one vector space, so the mode is
 * informational — but the field is on the interface so future providers (e.g.
 * Voyage, Cohere v3) can honor it without an API break.
 */
export type EmbeddingMode = 'document' | 'search';

export interface EmbeddingUsage {
  promptTokens: number;
  totalTokens: number;
}

export interface EmbedOptions {
  mode?: EmbeddingMode;
  /**
   * Caller deadline. Adapters COMBINE this with their own safety timeout rather
   * than replacing it, so a request that is abandoned early stops consuming
   * provider capacity while a hung provider is still bounded on its own.
   */
  signal?: AbortSignal;
}

export interface Embedder {
  /** Dimensionality of every vector this embedder returns. */
  readonly dimensions: number;

  /** Cumulative token count across every call made to this instance. */
  readonly totalTokens: number;

  /** Single text, single round-trip. Use `embedBatch` when possible. */
  embed(
    text: string,
    opts?: EmbedOptions,
  ): Promise<{ vector: number[]; usage: EmbeddingUsage }>;

  /**
   * Batch embed in one network round-trip. Order of `vectors` matches order
   * of `texts`. Empty input returns an empty vectors array with zero usage.
   */
  embedBatch(
    texts: string[],
    opts?: EmbedOptions,
  ): Promise<{ vectors: number[][]; usage: EmbeddingUsage }>;
}
