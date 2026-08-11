import { isAbortError, withDeadline } from '@crosmos/runtime';
import type { EmbedOptions, Embedder, EmbeddingUsage } from './port';

/**
 * Shared implementation for any provider that speaks the OpenAI `/embeddings`
 * wire format. OpenAI itself and OpenRouter both do — they differ only in
 * `baseUrl`, default model id, and a handful of optional headers (e.g.
 * OpenRouter's `HTTP-Referer` attribution). Mirrors the LLM side's
 * `OpenAICompatLLM` base class.
 *
 * Adapters subclass this and pass their concrete config; they don't
 * reimplement the request/response shape.
 *
 * `dimensions` is REQUIRED and is sent on the request (`text-embedding-3-*`
 * supports Matryoshka dimension reduction). It pins the output to the
 * deployment's vector space (the Vectorize index dimension) so the embedder
 * passes `assertEmbeddingSpace`. Both modes share one vector space for the
 * `text-embedding-3-*` family, so `mode` is informational only.
 */
const EMBED_REQUEST_TIMEOUT_MS = 30_000;

export interface OpenAICompatEmbedderConfig {
  baseUrl: string;
  apiKey: string;
  /** Model id, e.g. `text-embedding-3-small` or `openai/text-embedding-3-small`. */
  model: string;
  /** Output dimensionality — sent as the `dimensions` request param. */
  dimensions: number;
  /** Extra headers attached to every request (e.g. OpenRouter attribution). */
  extraHeaders?: Record<string, string>;
  /** Human label included in thrown errors — e.g. "OpenAI", "OpenRouter". */
  providerLabel: string;
}

interface EmbeddingsResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage?: { prompt_tokens: number; total_tokens: number };
}

export class OpenAICompatEmbedder implements Embedder {
  readonly dimensions: number;
  private _totalTokens = 0;

  constructor(private readonly config: OpenAICompatEmbedderConfig) {
    this.dimensions = config.dimensions;
  }

  get totalTokens(): number {
    return this._totalTokens;
  }

  async embed(text: string, opts?: EmbedOptions) {
    const { vectors, usage } = await this.embedBatch([text], opts);
    return { vector: vectors[0]!, usage };
  }

  async embedBatch(texts: string[], opts?: EmbedOptions) {
    if (texts.length === 0) {
      return {
        vectors: [],
        usage: { promptTokens: 0, totalTokens: 0 } satisfies EmbeddingUsage,
      };
    }

    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
          ...this.config.extraHeaders,
        },
        body: JSON.stringify({
          model: this.config.model,
          input: texts,
          dimensions: this.config.dimensions,
          // Pin float arrays — some providers default to base64 otherwise.
          encoding_format: 'float',
        }),
        // Caller deadline AND the adapter's own hung-provider bound; whichever
        // fires first wins. See `withDeadline`.
        signal: withDeadline(EMBED_REQUEST_TIMEOUT_MS, opts?.signal),
      });
    } catch (err) {
      // The CALLER's deadline fired, not ours. This is not a provider fault:
      // reporting it as a retryable embedding failure would blame the provider
      // for a request the client already abandoned, and would invite a retry of
      // work nobody is waiting for. Propagate the abort unchanged.
      if (isAbortError(err)) throw err;
      // Timeout / transient network failure → retryable (504) so the per-source
      // retry + queue backstop take over instead of the call hanging.
      const isTimeout = err instanceof DOMException && err.name === 'TimeoutError';
      throw new EmbeddingRequestError(
        `${this.config.providerLabel} embeddings request ${
          isTimeout
            ? `timed out after ${EMBED_REQUEST_TIMEOUT_MS}ms`
            : `failed: ${err instanceof Error ? err.message : String(err)}`
        }`,
        504,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new EmbeddingRequestError(
        `${this.config.providerLabel} embeddings ${res.status}: ${text || res.statusText}`,
        res.status,
      );
    }
    const json = (await res.json()) as EmbeddingsResponse;

    // Provider may return rows out of order; sort by `index` to match input order.
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    const vectors = sorted.map((row) => row.embedding);

    if (vectors.length !== texts.length) {
      throw new EmbeddingRequestError(
        `${this.config.providerLabel} embeddings returned ${vectors.length} vectors for ${texts.length} inputs`,
        500,
      );
    }
    // Guard the vector-space invariant at the source: a model/provider that
    // ignored `dimensions` would silently break retrieval downstream.
    const got = vectors[0]?.length ?? 0;
    if (got !== this.config.dimensions) {
      throw new EmbeddingRequestError(
        `${this.config.providerLabel} returned ${got}-dim vectors but ${this.config.dimensions} were requested ` +
          `(model ${this.config.model} may not support dimension reduction)`,
        500,
      );
    }

    const usage: EmbeddingUsage = {
      promptTokens: json.usage?.prompt_tokens ?? 0,
      totalTokens: json.usage?.total_tokens ?? 0,
    };
    this._totalTokens += usage.totalTokens;

    return { vectors, usage };
  }
}

export class EmbeddingRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'EmbeddingRequestError';
  }

  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}
