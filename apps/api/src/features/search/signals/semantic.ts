/**
 * Semantic signal — HNSW cosine search over `memories.embedding`. Port of
 * `app/engine/retrieval/semantic.py`.
 *
 * Scoped by `space_id` only (a space belongs to exactly one org) — matches
 * Python; do not add an org_id clause it doesn't have. Results are
 * distance-ordered, so once a score drops below the threshold all subsequent
 * ones do: BREAK (truncate), not filter.
 */
import { type Database, memories } from '@crosmos/db';
import { and, cosineDistance, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { SEMANTIC_MIN_SCORE } from '../constants';
import { toRankedCandidate } from '../mapping';
import { type RankedCandidate, SourceSignal } from '../types';

export async function semanticSearch(
  db: Database,
  queryEmbedding: number[],
  spaceId: number,
  limit: number,
): Promise<RankedCandidate[]> {
  const distance = cosineDistance(memories.embedding, queryEmbedding);
  const rows = await db
    // Parenthesize the distance: Postgres `-` binds tighter than pgvector's
    // `<=>`, so `1.0 - embedding <=> $1` would parse as `(1.0 - embedding) <=> $1`
    // → "operator does not exist: numeric - vector".
    .select({ memory: memories, score: sql<number>`1.0 - (${distance})` })
    .from(memories)
    .where(
      and(
        eq(memories.spaceId, spaceId),
        isNull(memories.forgottenAt),
        isNotNull(memories.embedding),
      ),
    )
    .orderBy(distance) // ascending distance = descending similarity
    .limit(limit);

  const candidates: RankedCandidate[] = [];
  let rank = 1;
  for (const row of rows) {
    const score = Number(row.score);
    if (score < SEMANTIC_MIN_SCORE) break;
    candidates.push(toRankedCandidate(row.memory, rank, score, SourceSignal.SEMANTIC));
    rank++;
  }
  return candidates;
}
