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
  /** Optional one-shot fallback used only when the primary returns HTTP 429. */
  rateLimitFallbackModel?: 'rerank-2.5-lite';
  /** Observability hook; exceptions are ignored and never affect retrieval. */
  onRateLimitFallback?: (event: {
    primaryModel: string;
    fallbackModel: string;
  }) => void;
}

interface VoyageRerankResponse {
  data?: Array<{ index?: number; relevance_score?: number }>;
  usage?: { total_tokens?: number };
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

    const primaryModel = opts?.model ?? this.defaultModel;
    let res = await this.request(query, documents, primaryModel, opts);
    const fallbackModel = this.config.rateLimitFallbackModel;
    if (
      res.status === 429
      && primaryModel === 'rerank-2.5'
      && fallbackModel !== undefined
    ) {
      // We do not need the primary error body and should free its connection
      // before issuing the fallback request.
      await res.body?.cancel().catch(() => undefined);
      try {
        this.config.onRateLimitFallback?.({ primaryModel, fallbackModel });
      } catch {
        // Logging/metrics hooks must never turn a successful degradation into a
        // retrieval failure.
      }
      res = await this.request(query, documents, fallbackModel, opts);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new RerankerRequestError(
        `Voyage ${res.status}: ${text || res.statusText}`,
        res.status,
      );
    }

    let json: VoyageRerankResponse;
    try {
      json = (await res.json()) as VoyageRerankResponse;
    } catch {
      throw new RerankerRequestError('Voyage returned invalid JSON', 502);
    }

    // The REST response follows Voyage's OpenAI-style envelope: rerank rows
    // live under `data` (not ZeroEntropy's `results`). Validate the optional
    // SDK fields at this boundary so a provider contract drift degrades through
    // the normal reranker error path instead of surfacing as an untyped
    // `undefined.map` exception.
    if (!Array.isArray(json.data)) {
      throw new RerankerRequestError('Voyage response is missing rerank data', 502);
    }

    const reranked: RerankResult[] = [];
    for (const result of json.data) {
      if (
        !Number.isInteger(result.index)
        || result.index! < 0
        || result.index! >= documents.length
        || typeof result.relevance_score !== 'number'
        || !Number.isFinite(result.relevance_score)
      ) {
        throw new RerankerRequestError('Voyage returned invalid rerank data', 502);
      }
      reranked.push({ index: result.index!, score: result.relevance_score });
    }
    return reranked.sort((a, b) => b.score - a.score);
  }

  private async request(
    query: string,
    documents: string[],
    model: string,
    opts?: RerankOptions,
  ): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(VOYAGE_RERANK_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
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
    return res;
  }
}
