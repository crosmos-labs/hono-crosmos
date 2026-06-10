import type { RerankOptions, RerankResult, Reranker } from './port';
import { RerankerRequestError } from './zeroentropy';

/**
 * Cloudflare Workers AI `@cf/baai/bge-reranker-base`. Runs via the `AI` binding
 * (`env.AI.run`) — edge-native, no external HTTP round-trip, replacing the
 * ZeroEntropy HTTP reranker to cut retrieval latency.
 *
 * The model takes a query + a list of `contexts` (each `{ text }`) and returns
 * `response[]` of `{ id, score }`, where `id` is the index into the input
 * `contexts`. Scores are raw logits; downstream (`search/reranker.ts`) clamps
 * to [0, 1], so no sigmoid is applied here — only relative ordering matters.
 */
const DEFAULT_MODEL = '@cf/baai/bge-reranker-base';

export interface WorkersAiRerankerConfig {
  /** The `AI` binding from the Worker env (`env.AI`). */
  ai: Ai;
}

interface BgeRerankOutput {
  response: Array<{ id: number; score: number }>;
}

export class WorkersAiReranker implements Reranker {
  readonly defaultModel = DEFAULT_MODEL;

  constructor(private readonly config: WorkersAiRerankerConfig) {}

  async rerank(
    query: string,
    documents: string[],
    opts?: RerankOptions,
  ): Promise<RerankResult[]> {
    if (documents.length === 0) return [];

    const inputs: Record<string, unknown> = {
      query,
      contexts: documents.map((text) => ({ text })),
    };
    if (opts?.topK !== undefined) inputs.top_k = opts.topK;

    let output: BgeRerankOutput;
    try {
      output = (await this.config.ai.run(
        opts?.model ?? this.defaultModel,
        inputs,
      )) as unknown as BgeRerankOutput;
    } catch (err) {
      throw new RerankerRequestError(
        `Workers AI rerank (${opts?.model ?? this.defaultModel}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        503,
      );
    }

    const results = output?.response ?? [];
    return results
      .map((r) => ({ index: r.id, score: r.score }))
      .sort((a, b) => b.score - a.score);
  }
}
