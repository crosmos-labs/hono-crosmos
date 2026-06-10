import type { EmbedOptions, Embedder, EmbeddingUsage } from './port';

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';

/**
 * OpenAI `text-embedding-3-small` at 1536 dimensions. Fallback provider
 * (`EMBEDDINGS_PROVIDER=openai`); the default is Workers AI bge-m3 at 1024. Note
 * the schema columns / Vectorize index default to 1024 — using this provider
 * requires matching the stored-vector dimension (re-ingest at 1536).
 *
 * `text-embedding-3-small` is symmetric: document and search modes share one
 * vector space, so the `mode` option on the interface is ignored here. Callers
 * still pass it so a future asymmetric provider can honor it without a code
 * change.
 */
const MODEL = 'text-embedding-3-small';
const DIMENSIONS = 1536;

export interface OpenAIEmbedderConfig {
  apiKey: string;
}

interface EmbeddingsResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage?: { prompt_tokens: number; total_tokens: number };
}

export class OpenAIEmbedder implements Embedder {
  readonly dimensions = DIMENSIONS;
  private _totalTokens = 0;

  constructor(private readonly config: OpenAIEmbedderConfig) {}

  get totalTokens(): number {
    return this._totalTokens;
  }

  async embed(text: string, opts?: EmbedOptions) {
    const { vectors, usage } = await this.embedBatch([text], opts);
    return { vector: vectors[0]!, usage };
  }

  async embedBatch(texts: string[], _opts?: EmbedOptions) {
    if (texts.length === 0) {
      return {
        vectors: [],
        usage: { promptTokens: 0, totalTokens: 0 } satisfies EmbeddingUsage,
      };
    }

    const res = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        input: texts,
        dimensions: DIMENSIONS,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new EmbeddingRequestError(
        `OpenAI embeddings ${res.status}: ${text || res.statusText}`,
        res.status,
      );
    }
    const json = (await res.json()) as EmbeddingsResponse;

    // Provider may return rows out of order; sort by `index` to match input order.
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    const vectors = sorted.map((row) => row.embedding);

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
