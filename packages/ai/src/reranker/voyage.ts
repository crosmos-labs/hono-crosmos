import { isAbortError, withDeadline } from '@crosmos/runtime';
import type { RerankOptions, RerankResult, Reranker } from './port';
import { RerankerRequestError } from './zeroentropy';

const VOYAGE_RERANK_URL = 'https://api.voyageai.com/v1/rerank';
const RERANK_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MODEL = 'rerank-2.5';

export interface VoyageRerankerConfig {
  apiKey: string;
  /** Defaults to Voyage's quality-oriented `rerank-2.5`. */
  model?: 'rerank-2.5' | 'rerank-2.5-lite';
}

interface VoyageRerankResponse {
  results: Array<{ index: number; relevance_score: number }>;
  total_tokens?: number;
}

/**
 * Voyage rerank-2.5 adapter.
 *
 * Voyage truncates overlong query/document pairs by default. Pin that behavior
 * explicitly so an upstream default change cannot turn a long memory into a
 * retrieval failure. Documents are not echoed back because the caller already
 * owns them and only needs the original indexes and scores.
 */
export class VoyageReranker implements Reranker {
  readonly defaultModel: string;

  constructor(private readonly config: VoyageRerankerConfig) {
    this.defaultModel = config.model ?? DEFAULT_MODEL;
  }

  async rerank(
    query: string,
    documents: string[],
    opts?: RerankOptions,
  ): Promise<RerankResult[]> {
    if (documents.length === 0) return [];

    let res: Response;
    try {
      res = await fetch(VOYAGE_RERANK_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: opts?.model ?? this.defaultModel,
          query,
          documents,
          return_documents: false,
          truncation: true,
          ...(opts?.topK !== undefined ? { top_k: opts.topK } : {}),
        }),
        signal: withDeadline(RERANK_REQUEST_TIMEOUT_MS, opts?.signal),
      });
    } catch (err) {
      if (isAbortError(err)) throw err;
      const isTimeout = err instanceof DOMException && err.name === 'TimeoutError';
      throw new RerankerRequestError(
        `Voyage rerank ${
          isTimeout
            ? `timed out after ${RERANK_REQUEST_TIMEOUT_MS}ms`
            : `failed: ${err instanceof Error ? err.message : String(err)}`
        }`,
        504,
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new RerankerRequestError(
        `Voyage ${res.status}: ${text || res.statusText}`,
        res.status,
      );
    }

    const json = (await res.json()) as VoyageRerankResponse;
    return json.results
      .map((result) => ({ index: result.index, score: result.relevance_score }))
      .sort((a, b) => b.score - a.score);
  }
}
