import type { EmbedOptions, Embedder, EmbeddingUsage } from './port';
import { EmbeddingRequestError } from './openai';

/**
 * Cloudflare Workers AI `@cf/baai/bge-m3` at 1024 dimensions. Runs via the
 * `AI` binding (`env.AI.run`) — edge-native, no external HTTP round-trip, which
 * is the whole point of moving off OpenAI: lower retrieval/ingestion latency.
 *
 * bge-m3 is symmetric (one vector space for documents and queries), so the
 * `mode` option on the interface is ignored here. Callers still pass it so a
 * future asymmetric provider can honor it without a code change.
 *
 * Workers AI does not report token usage, so `usage` is always zero. The port
 * allows this and the only consumer (cost logging) treats zero as "unknown".
 */
const MODEL = '@cf/baai/bge-m3';
const DIMENSIONS = 1024;

/**
 * Bound on a single embedding call. The `AI` binding's `run()` doesn't accept
 * an AbortSignal, so we race it against a timer — on timeout we stop waiting
 * (the underlying call may finish in the background, harmlessly) and throw a
 * retryable error rather than letting a stuck call wedge the ingestion job.
 * Mirrors the LLM client's timeout; defense-in-depth for the embedder path.
 */
const EMBED_REQUEST_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new EmbeddingRequestError(`${label} timed out after ${ms}ms`, 504)),
        ms,
      ),
    ),
  ]);
}

export interface WorkersAiEmbedderConfig {
  /** The `AI` binding from the Worker env (`env.AI`). */
  ai: Ai;
}

interface BgeEmbeddingOutput {
  shape: number[];
  data: number[][];
}

export class WorkersAiEmbedder implements Embedder {
  readonly dimensions = DIMENSIONS;
  private _totalTokens = 0;

  constructor(private readonly config: WorkersAiEmbedderConfig) {}

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

    let output: BgeEmbeddingOutput;
    try {
      // `Ai.run` is heavily overloaded in workers-types; cast the result to the
      // documented bge-m3 sync output shape (`{ shape, data }`). Raced against a
      // timeout so a stuck call can't wedge the job (see withTimeout).
      output = (await withTimeout(
        this.config.ai.run(MODEL, { text: texts }),
        EMBED_REQUEST_TIMEOUT_MS,
        `Workers AI embeddings (${MODEL})`,
      )) as unknown as BgeEmbeddingOutput;
    } catch (err) {
      // Already-typed errors (e.g. the timeout, status 504) pass through so we
      // don't relabel them; everything else surfaces as the same error type the
      // OpenAI adapter throws. 503 = retryable per `EmbeddingRequestError`.
      if (err instanceof EmbeddingRequestError) throw err;
      throw new EmbeddingRequestError(
        `Workers AI embeddings (${MODEL}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        503,
      );
    }

    const vectors = output?.data ?? [];
    if (vectors.length !== texts.length) {
      throw new EmbeddingRequestError(
        `Workers AI embeddings returned ${vectors.length} vectors for ${texts.length} inputs`,
        500,
      );
    }

    const usage: EmbeddingUsage = { promptTokens: 0, totalTokens: 0 };
    return { vectors, usage };
  }
}
