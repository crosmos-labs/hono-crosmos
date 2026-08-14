/**
 * Semantic signal — ANN cosine search via the configured vector store
 * (pgvector or Vectorize/Qdrant). Port of `app/engine/retrieval/semantic.py`.
 *
 * Flow: the vector store returns candidate ids (filtered by org+space); we then
 * hydrate those ids by id through `hydrateMemories`, which applies the full
 * visibility clause (org + space + per-user). An id the caller can't see — or
 * that was forgotten since indexing — is simply absent from the hydrated map and
 * dropped here. This is the same intersection the old code did against the
 * pre-loaded working set, now done as a bounded by-id query instead of loading
 * the whole space. Results stay similarity-ordered (queryNearest already
 * truncates below `SEMANTIC_MIN_SCORE`).
 */
import type { Database } from '@crosmos/db';
import type { VectorMatch, VectorStore } from '@crosmos/vector';
import type { TenantScope } from '@crosmos/types';
import { hydrateMemories } from '../candidates';
import { SEMANTIC_MIN_SCORE } from '../constants';
import { toRankedCandidate } from '../mapping';
import { type RankedCandidate, SourceSignal } from '../types';

export async function semanticSearch(
  db: Database,
  vectorStore: VectorStore,
  queryEmbedding: number[],
  scope: TenantScope,
  limit: number,
  signal?: AbortSignal,
  matchesOverride?: VectorMatch[],
): Promise<RankedCandidate[]> {
  const matches = matchesOverride ?? await vectorStore.queryNearest(
    'memories',
    queryEmbedding,
    scope,
    { topK: limit, minScore: SEMANTIC_MIN_SCORE, signal },
  );
  if (matches.length === 0) return [];

  const rows = await hydrateMemories(db, scope, matches.map((m) => m.id));

  const candidates: RankedCandidate[] = [];
  let rank = 1;
  for (const match of matches) {
    const memory = rows.get(match.id);
    // Not visible to this caller (other-user private), or forgotten since
    // indexing → skip. Enforces visibility for every vector backend.
    if (memory === undefined) continue;
    candidates.push(toRankedCandidate(memory, rank, match.score, SourceSignal.SEMANTIC));
    rank++;
  }
  return candidates;
}
