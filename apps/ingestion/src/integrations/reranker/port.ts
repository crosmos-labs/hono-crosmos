/**
 * Reranker provider — used by retrieval (not ingestion) to reorder candidate
 * documents against a query. Lives in the ingestion app for now because
 * that's where all the AI integrations are scaffolded; will likely move to a
 * shared `packages/ai/` once retrieval lands and both workers need it (see
 * docs/ingestion_migration/decisions.md §9).
 *
 * Implementations: see `./zeroentropy.ts`. Pick one via `getReranker(env)`.
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
