import { isAbortError, withDeadline } from '@crosmos/runtime';
import type { RerankOptions, RerankResult, Reranker } from './port';

const ZEROENTROPY_RERANK_URL = 'https://api.zeroentropy.dev/v1/models/rerank';

/**
 * Hung-provider bound. Generous relative to the 6s retrieval deadline (the
 * caller's signal normally fires first); this exists so a reranker call made
 * OUTSIDE a request deadline still cannot pin an isolate forever.
 */
const RERANK_REQUEST_TIMEOUT_MS = 10_000;

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
      // `fast` guarantees subsecond inference; the `slow` mode trades latency
      // (>10s) for higher rate limits. Retrieval is latency-critical, so pin
      // fast explicitly rather than rely on the API default.
      latency: 'fast',
    };
    if (opts?.topK !== undefined) body.top_n = opts.topK;

    let res: Response;
    try {
      res = await fetch(ZEROENTROPY_RERANK_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        // This call previously had NO timeout at all, so a wedged reranker could
        // hang an isolate indefinitely — the same failure shape that stalled
        // ingestion via the untimed LLM fetch. `withDeadline` bounds that AND
        // honours the caller's request deadline.
        signal: withDeadline(RERANK_REQUEST_TIMEOUT_MS, opts?.signal),
      });
    } catch (err) {
      // A caller-deadline abort is not a provider fault; propagate unchanged so
      // it is not logged or retried as one.
      if (isAbortError(err)) throw err;
      const isTimeout = err instanceof DOMException && err.name === 'TimeoutError';
      throw new RerankerRequestError(
        `ZeroEntropy rerank ${
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
