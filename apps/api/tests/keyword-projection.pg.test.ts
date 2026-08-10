/**
 * P1-E — keyword search projects only the columns ranking reads.
 *
 * `keywordSearch` selected the whole `memories` row, which drags `embedding`
 * (a 1536-dimension vector) and `meta` out of Postgres for up to
 * GIN_CANDIDATE_LIMIT candidates on every keyword search, none of which the
 * ranking pipeline or the response mapper ever reads.
 *
 * A projection change is only safe if every value that survives into a
 * candidate is byte-identical, so this compares the current implementation
 * against one that selects the full row, over the same real fixture.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { type Database, memories } from '@crosmos/db';
import type { TenantScope } from '@crosmos/types';
import { and, desc, isNull, sql } from 'drizzle-orm';
import { scopeMemories } from '../src/lib/scope';
import { GIN_CANDIDATE_LIMIT, MIN_KEYWORD_SCORE } from '../src/features/search/constants';
import { toRankedCandidate } from '../src/features/search/mapping';
import { keywordSearch } from '../src/features/search/signals/keyword';
import { boundTsqueryText } from '../src/features/search/tsquery';
import { type RankedCandidate, SourceSignal } from '../src/features/search/types';
import {
  announceSkip,
  getTestDb,
  resetTestData,
  seedMemory,
  seedTenant,
  type Tenant,
} from './helpers/test-db';

const db: Database | null = await getTestDb();
if (db === null) announceSkip('keyword-projection.pg.test.ts');
const describeDb = db === null ? describe.skip : describe;

let tenant: Tenant;

afterAll(async () => {
  if (db !== null) await resetTestData(db);
});

beforeEach(async () => {
  if (db === null) return;
  await resetTestData(db);
  tenant = await seedTenant(db);
});

/** The pre-change implementation: identical apart from selecting the full row. */
async function legacyKeywordSearch(
  queryText: string,
  database: Database,
  scope: TenantScope,
  limit: number,
): Promise<RankedCandidate[]> {
  const tsQuery = sql`websearch_to_tsquery('english', ${boundTsqueryText(queryText)})`;
  const tsVector = sql`to_tsvector('english', ${memories.content})`;
  const rankExpr = sql<number>`ts_rank_cd(${tsVector}, ${tsQuery}, 33)`;

  const rows = await database
    .select({ memory: memories, rank: rankExpr })
    .from(memories)
    .where(
      and(scopeMemories(scope), isNull(memories.forgottenAt), sql`${tsVector} @@ ${tsQuery}`),
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
    candidates.push(toRankedCandidate(rows[i]!.memory, idx, score, SourceSignal.KEYWORD));
  }
  return candidates.slice(0, limit);
}

const orgScope = (t: Tenant): TenantScope => ({
  orgId: t.orgId,
  spaceId: t.spaceId,
  userId: t.userId,
});

async function assertIdentical(
  query: string,
  scope: TenantScope,
  limit = 50,
): Promise<RankedCandidate[]> {
  const legacy = await legacyKeywordSearch(query, db!, scope, limit);
  const current = await keywordSearch(query, db!, scope, limit);
  // Deep equality across every candidate field, not just ids: rank position,
  // normalized score and each hydrated value must all survive the projection.
  expect(current).toEqual(legacy);
  return current;
}

describeDb('keywordSearch — projected columns produce identical candidates', () => {
  test('candidate ids, ranks, scores and hydrated values are unchanged', async () => {
    await seedMemory(db!, tenant, { content: 'the user prefers dark roast coffee' });
    await seedMemory(db!, tenant, { content: 'coffee is served in the kitchen' });
    await seedMemory(db!, tenant, { content: 'unrelated note about bicycles' });

    const candidates = await assertIdentical('coffee', orgScope(tenant));
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((c) => c.source === SourceSignal.KEYWORD)).toBe(true);
    // Rank positions are dense and 1-based.
    expect(candidates.map((c) => c.rank)).toEqual(
      candidates.map((_, i) => i + 1),
    );
  });

  test('normalized scores are top-relative and the top hit is exactly 1', async () => {
    await seedMemory(db!, tenant, { content: 'coffee coffee coffee espresso' });
    await seedMemory(db!, tenant, { content: 'a passing mention of coffee' });

    const candidates = await assertIdentical('coffee', orgScope(tenant));
    expect(candidates[0]!.score).toBe(1);
  });

  test('forgotten memories are excluded identically', async () => {
    const live = await seedMemory(db!, tenant, { content: 'coffee is good' });
    await seedMemory(db!, tenant, { content: 'coffee is bad', forgotten: true });

    const candidates = await assertIdentical('coffee', orgScope(tenant));
    expect(candidates.map((c) => c.memoryId)).toEqual([live]);
  });

  test('per-user visibility scoping is unchanged', async () => {
    const orgVisible = await seedMemory(db!, tenant, {
      content: 'coffee for everyone',
      visibility: 'org',
    });
    const mine = await seedMemory(db!, tenant, {
      content: 'coffee just for me',
      visibility: 'private',
      ownerUserId: tenant.userId,
    });
    await seedMemory(db!, tenant, {
      content: 'coffee belonging to someone else',
      visibility: 'private',
      ownerUserId: tenant.otherUserId,
    });

    const scoped: TenantScope = {
      ...orgScope(tenant),
      visibleUserIds: [tenant.userId],
    };
    const candidates = await assertIdentical('coffee', scoped);
    expect(new Set(candidates.map((c) => c.memoryId))).toEqual(
      new Set([orgVisible, mine]),
    );
  });

  test('cross-space rows never leak', async () => {
    await seedMemory(db!, tenant, { content: 'coffee in this space' });
    const otherSpace: TenantScope = {
      ...orgScope(tenant),
      spaceId: tenant.spaceId + 999,
    };
    expect(await assertIdentical('coffee', otherSpace)).toEqual([]);
  });

  test('a no-match query returns nothing from both implementations', async () => {
    await seedMemory(db!, tenant, { content: 'coffee' });
    expect(await assertIdentical('helicopter', orgScope(tenant))).toEqual([]);
  });

  test('the caller limit is applied identically', async () => {
    for (let i = 0; i < 12; i++) {
      await seedMemory(db!, tenant, { content: `coffee note number ${i}` });
    }
    const candidates = await assertIdentical('coffee', orgScope(tenant), 5);
    expect(candidates).toHaveLength(5);
  });

  test('a pathological repeated-token query still matches the old behavior', async () => {
    await seedMemory(db!, tenant, { content: 'coffee and tea' });
    // Exercises `boundTsqueryText`; both implementations must bound identically.
    const query = Array.from({ length: 400 }, () => 'coffee').join(' ');
    await assertIdentical(query, orgScope(tenant));
  });
});
