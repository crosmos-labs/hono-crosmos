/**
 * Semantic signal — ANN cosine search via the configured vector store
 * (pgvector or Vectorize). Port of `app/engine/retrieval/semantic.py`.
 *
 * The vector store returns candidate ids (filtered by org+space); we resolve
 * each against the already-loaded, visibility-filtered working set
 * (`memoryById` from `candidates.ts`). That intersection enforces visibility —
 * the Vectorize backend can't express the per-user OR in its filter, so a
 * returned id that isn't in the visible set is dropped here. Results are
 * similarity-ordered, so `queryNearest` already truncates below
 * `SEMANTIC_MIN_SCORE`.
 */
import type { Memory } from '@crosmos/db';
import type { VectorStore } from '@crosmos/vector';
import type { TenantScope } from '@crosmos/types';
import { SEMANTIC_MIN_SCORE } from '../constants';
import { toRankedCandidate } from '../mapping';
import { type RankedCandidate, SourceSignal } from '../types';

export async function semanticSearch(
  vectorStore: VectorStore,
  queryEmbedding: number[],
  scope: TenantScope,
  limit: number,
  memoryById: Map<number, Memory>,
): Promise<RankedCandidate[]> {
  const matches = await vectorStore.queryNearest('memories', queryEmbedding, scope, {
    topK: limit,
    minScore: SEMANTIC_MIN_SCORE,
  });

  const candidates: RankedCandidate[] = [];
  let rank = 1;
  for (const match of matches) {
    const memory = memoryById.get(match.id);
    // Not in the visible working set (other-user private, or forgotten since
    // indexing) → skip. Enforces visibility for the Vectorize backend.
    if (memory === undefined) continue;
    candidates.push(toRankedCandidate(memory, rank, match.score, SourceSignal.SEMANTIC));
    rank++;
  }
  return candidates;
}
