/**
 * Keyword signal — GIN fulltext via `ts_rank_cd` + `websearch_to_tsquery`.
 * Port of `app/engine/retrieval/keyword.py`.
 *
 * The SQL LIMIT is GIN_CANDIDATE_LIMIT (100), independent of `candidate_pool`;
 * the function `limit` (50) is applied AFTER normalization via slice. Scores
 * are normalized against the top hit; sub-threshold scores are skipped
 * (CONTINUE, not break — asymmetric vs semantic). The `to_tsvector('english',
 * content)` expression MUST match the GIN index expression for index use.
 */
import { type Database, memories } from '@crosmos/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { GIN_CANDIDATE_LIMIT, MIN_KEYWORD_SCORE } from '../constants';
import { toRankedCandidate } from '../mapping';
import { type RankedCandidate, SourceSignal } from '../types';

export async function keywordSearch(
  queryText: string,
  db: Database,
  spaceId: number,
  limit: number,
): Promise<RankedCandidate[]> {
  const tsQuery = sql`websearch_to_tsquery('english', ${queryText})`;
  const tsVector = sql`to_tsvector('english', ${memories.content})`;
  const rankExpr = sql<number>`ts_rank_cd(${tsVector}, ${tsQuery}, 33)`;

  const rows = await db
    .select({ memory: memories, rank: rankExpr })
    .from(memories)
    .where(
      and(
        eq(memories.spaceId, spaceId),
        isNull(memories.forgottenAt),
        sql`${tsVector} @@ ${tsQuery}`,
      ),
    )
    .orderBy(desc(rankExpr))
    .limit(GIN_CANDIDATE_LIMIT);

  if (rows.length === 0) return [];

  const ranks = rows.map((r) => Number(r.rank));
  const maxRank = Math.max(...ranks, 0.0);
  if (maxRank === 0.0) return [];

  const candidates: RankedCandidate[] = [];
  let rankIdx = 1;
  for (let i = 0; i < rows.length; i++) {
    const score = ranks[i]! / maxRank;
    const idx = rankIdx;
    rankIdx++;
    if (score < MIN_KEYWORD_SCORE) continue;
    candidates.push(
      toRankedCandidate(rows[i]!.memory, idx, score, SourceSignal.KEYWORD),
    );
  }
  return candidates.slice(0, limit);
}
