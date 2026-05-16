import type { Env } from '../../bindings';
import type { Reranker } from './port';
import { ZeroEntropyReranker } from './zeroentropy';

export type { Reranker, RerankResult, RerankOptions } from './port';
export { RerankerRequestError } from './zeroentropy';

/**
 * Returns the configured reranker for this environment. Today the only
 * implementation is ZeroEntropy `zerank-2`. To add another (Cohere Rerank,
 * Voyage Rerank): drop an adapter, add a `RERANKER_PROVIDER` env var, branch
 * here.
 */
export function getReranker(env: Env): Reranker {
  if (!env.ZEROENTROPY_API_KEY) {
    throw new Error('ZEROENTROPY_API_KEY is required for the reranker');
  }
  return new ZeroEntropyReranker({ apiKey: env.ZEROENTROPY_API_KEY });
}
