import type { RerankOptions, RerankResult, Reranker } from './port';

const ZEROENTROPY_RERANK_URL = 'https://api.zeroentropy.dev/v1/models/rerank';

/**
 * ZeroEntropy `zerank-2`. Matches the retrieval reranker called out in
 * .codex/deployed-architecture.md. Score is unbounded but typically
 * in 0..1 for `zerank-2`; relative ordering is what callers should use.
 */
const DEFAULT_MODEL = 'zerank-2';

export interface ZeroEntropyConfig {
  apiKey: string;
}

interface ZeroEntropyResponse {
  results: Array<{ index: number; relevance_score: number }>;
}

export class ZeroEntropyReranker implements Reranker {
  readonly defaultModel = DEFAULT_MODEL;

  constructor(private readonly config: ZeroEntropyConfig) {}

  async rerank(
    query: string,
    documents: string[],
    opts?: RerankOptions,
  ): Promise<RerankResult[]> {
    if (documents.length === 0) return [];

    const body: Record<string, unknown> = {
      model: opts?.model ?? this.defaultModel,
      query,
      documents,
    };
    if (opts?.topK !== undefined) body.top_n = opts.topK;

    const res = await fetch(ZEROENTROPY_RERANK_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new RerankerRequestError(
        `ZeroEntropy ${res.status}: ${text || res.statusText}`,
        res.status,
      );
    }
    const json = (await res.json()) as ZeroEntropyResponse;
    return json.results
      .map((r) => ({ index: r.index, score: r.relevance_score }))
      .sort((a, b) => b.score - a.score);
  }
}

export class RerankerRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'RerankerRequestError';
  }

  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}
