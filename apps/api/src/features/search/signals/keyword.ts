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
import type { TenantScope } from '@crosmos/types';
import { and, desc, isNull, sql } from 'drizzle-orm';
import { scopeMemories } from '../../../lib/scope';
import { retrievalMemoryColumns } from '../candidates';
import { GIN_CANDIDATE_LIMIT, MIN_KEYWORD_SCORE } from '../constants';
import { toRankedCandidate } from '../mapping';
import { boundTsqueryText } from '../tsquery';
import { type RankedCandidate, SourceSignal } from '../types';

export async function keywordSearch(
  queryText: string,
  db: Database,
  scope: TenantScope,
  limit: number,
): Promise<RankedCandidate[]> {
  // Bounded before it reaches Postgres — an oversized expression raises
  // `tsquery stack too small`. No-op for queries already within the bounds, so
  // ranking is unchanged for all normal traffic.
  const tsQuery = sql`websearch_to_tsquery('english', ${boundTsqueryText(queryText)})`;
  const tsVector = sql`to_tsvector('english', ${memories.content})`;
  const rankExpr = sql<number>`ts_rank_cd(${tsVector}, ${tsQuery}, 33)`;

  const rows = await db
    // Project only the columns ranking actually reads. Selecting the whole row
    // pulled `embedding` — a 1536-dimension vector per candidate, up to
    // GIN_CANDIDATE_LIMIT of them — plus `meta`, out of Postgres and into Worker
    // memory on every keyword search, none of which is ever read. The column set
    // is `retrievalMemoryColumns`, the same projection every other signal
    // hydrates with, so candidate values are unchanged.
    .select({ memory: retrievalMemoryColumns, rank: rankExpr })
    .from(memories)
    .where(
      and(
        scopeMemories(scope),
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
