/**
 * Reranker provider — used by retrieval to reorder candidate documents
 * against a query.
 *
 * Implementations: see `./zeroentropy.ts`. Each consuming app wires one from
 * its own env (e.g. `getReranker(env)`).
 */
export interface RerankResult {
  /** Index into the original `documents` array passed to `rerank`. */
  index: number;
  /** Provider score, higher = more relevant. Range depends on provider. */
  score: number;
}

export interface RerankOptions {
  /** Return only the top-K. Default: all documents, sorted by score desc. */
  topK?: number;
  /** Override the provider's default model id. */
  model?: string;
}

export interface Reranker {
  /** The model id used when `rerank` is called without an override. */
  readonly defaultModel: string;

  /**
   * Rerank `documents` against `query`. Returned results are sorted by score
   * descending. Empty `documents` returns an empty array — no network call.
   */
  rerank(
    query: string,
    documents: string[],
    opts?: RerankOptions,
  ): Promise<RerankResult[]>;
}
