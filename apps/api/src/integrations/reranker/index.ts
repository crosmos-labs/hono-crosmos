import { WorkersAiReranker, ZeroEntropyReranker } from '@crosmos/ai';
import type { Reranker } from '@crosmos/ai';
import { createLogger } from '@crosmos/observability';
import type { Env } from '../../bindings';
import { isRerankerEnabled } from '../../features/search/constants';

export type { Reranker } from '@crosmos/ai';

/**
 * Cross-encoder reranker for retrieval, or `null` when reranking is disabled.
 *
 * Selected by `RERANKER_PROVIDER`:
 *   - `workers-ai` (default) — Cloudflare `@cf/baai/bge-reranker-base` via the
 *     `AI` binding. Edge-native, no API key.
 *   - `zeroentropy` — ZeroEntropy `zerank-2` over HTTP. Requires
 *     `ZEROENTROPY_API_KEY`; if missing we return `null` (logged) rather than
 *     throwing — retrieval still works via the RRF rank-remap fallback.
 *
 * The outer `RETRIEVAL_RERANKER_ENABLED` toggle gates construction entirely
 * (mirrors Python's `dependencies.py`).
 */
export function getReranker(env: Env): Reranker | null {
  if (!isRerankerEnabled(env.RETRIEVAL_RERANKER_ENABLED)) return null;

  const provider = env.RERANKER_PROVIDER ?? 'workers-ai';
  if (provider === 'zeroentropy') {
    if (!env.ZEROENTROPY_API_KEY) {
      createLogger({
        service: 'api',
        environment: env.ENVIRONMENT,
      }).warn('retrieval.reranker_missing_api_key', { stage: 'reranker_init' });
      return null;
    }
    return new ZeroEntropyReranker({ apiKey: env.ZEROENTROPY_API_KEY });
  }

  if (!env.AI) {
    createLogger({
      service: 'api',
      environment: env.ENVIRONMENT,
    }).warn('retrieval.reranker_missing_ai_binding', { stage: 'reranker_init' });
    return null;
  }
  return new WorkersAiReranker({ ai: env.AI });
}
