import { ZeroEntropyReranker } from '@crosmos/ai';
import type { Reranker } from '@crosmos/ai';
import type { Env } from '../../bindings';
import { isRerankerEnabled } from '../../features/search/constants';

export type { Reranker } from '@crosmos/ai';

/**
 * Cross-encoder reranker for retrieval, or `null` when reranking is disabled.
 *
 * Mirrors Python's `dependencies.py`: the reranker is included only when
 * `RETRIEVAL_RERANKER_ENABLED` is on. When on but no API key is configured we
 * return `null` (logged) rather than throwing — retrieval still works via the
 * RRF rank-remap fallback (`ce_enabled = reranker is not None && …`).
 */
export function getReranker(env: Env): Reranker | null {
  if (!isRerankerEnabled(env.RETRIEVAL_RERANKER_ENABLED)) return null;
  if (!env.ZEROENTROPY_API_KEY) {
    console.warn('reranker_enabled_but_no_api_key — falling back to RRF');
    return null;
  }
  return new ZeroEntropyReranker({ apiKey: env.ZEROENTROPY_API_KEY });
}
