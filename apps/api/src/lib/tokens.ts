/**
 * Rough input-token estimate for quota metering.
 *
 * The monthly `tokens_ingested` quota meters what the USER submits — the size of
 * the source content they send us — NOT the pipeline's internal LLM/embedder
 * throughput (system prompts, the dedup hint, both extraction passes, embeddings).
 * That throughput is real provider cost and is tracked separately as a metric,
 * but it's 10–50× the submitted content and makes a useless user-facing quota.
 *
 * Uses OpenAI's ~4-chars-per-token rule of thumb. Deliberately dependency-free
 * (no tokenizer in the Worker bundle): for a quota an estimate within ~15% is
 * fine, and it costs zero bundle/CPU on the edge.
 */
export function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}
