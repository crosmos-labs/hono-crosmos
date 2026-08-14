/**
 * P1-E — graph edge bounds pushed into SQL, proven equivalent.
 *
 * `getEdgesForEntities` used to return every matching edge and let JavaScript
 * apply the confidence rule and the per-hop cap. A high-degree entity therefore
 * transferred its entire edge list out of Postgres so that all but the first 200
 * could be discarded in the Worker.
 *
 * Moving a filter into SQL is only safe if it selects exactly the same rows in
 * exactly the same order, and that depends on NULL handling, float comparison
 * and tie-break order — none of which a hand-written fake reproduces faithfully.
 * So this suite runs the OLD JavaScript pipeline and the NEW SQL one against the
 * same real Postgres fixture and asserts the edge id sequences are identical.
 *
 * Requires the local test database; see `helpers/test-db.ts`.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { type Database, edges } from '@crosmos/db';
import type { TenantScope } from '@crosmos/types';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { graphEdgeVisibilityClause } from '../src/lib/scope';
import {
  GRAPH_MAX_EDGES_PER_HOP,
  GRAPH_MIN_CONFIDENCE,
} from '../src/features/search/constants';
import {
  getEdgesForEntities,
  graphSearchWithStore,
} from '../src/features/search/signals/graph';
import {
  announceSkip,
  getTestDb,
  resetTestData,
  seedEdge,
  seedEdges,
  seedEntity,
  seedMemory,
  seedTenant,
  MemoryVectorStore,
  type Tenant,
} from '@crosmos/test-support';

// Resolved at module scope, NOT in `beforeAll`: `describe.skip` has to be
// chosen while the suite is being defined, and a `beforeAll` runs after that.
const db: Database | null = await getTestDb();
if (db === null) announceSkip('graph-edges.pg.test.ts');
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

/**
 * The behavior as it was BEFORE this change: fetch everything, then dedup,
 * confidence-filter and cap in JavaScript. Kept verbatim here as the reference
 * implementation the SQL version must match.
 */
async function legacyEdgesForEntities(
  database: Database,
  entityIds: number[],
  asOf: Date | null,
  scope: TenantScope,
): ReturnType<typeof getEdgesForEntities> {
  if (entityIds.length === 0) return [];
  const effectiveTime = sql`coalesce(${edges.validFrom}, ${edges.recordedAt})`;

  const conditions = [
    isNull(edges.forgottenAt),
    or(
      inArray(edges.sourceEntityId, entityIds),
      inArray(edges.targetEntityId, entityIds),
    )!,
    eq(edges.orgId, scope.orgId),
    eq(edges.spaceId, scope.spaceId),
  ];
  const visibility = graphEdgeVisibilityClause(scope);
  if (visibility !== undefined) conditions.push(visibility);
  if (asOf !== null) {
    conditions.push(sql`${effectiveTime} <= ${asOf.toISOString()}::timestamptz`);
  }

  const rows = await database
    .select({
      id: edges.id,
      sourceEntityId: edges.sourceEntityId,
      targetEntityId: edges.targetEntityId,
      memoryId: edges.memoryId,
      confidence: edges.confidence,
      validFrom: edges.validFrom,
      recordedAt: edges.recordedAt,
    })
    .from(edges)
    .where(and(...conditions))
    .orderBy(sql`${effectiveTime} desc`, desc(edges.id));

  const seen = new Set<number>();
  let filtered = [] as typeof rows;
  for (const edge of rows) {
    if (seen.has(edge.id)) continue;
    seen.add(edge.id);
    const confidence = edge.confidence ?? 1.0;
    if (confidence >= GRAPH_MIN_CONFIDENCE) filtered.push(edge);
  }
  if (filtered.length > GRAPH_MAX_EDGES_PER_HOP) {
    filtered = filtered.slice(0, GRAPH_MAX_EDGES_PER_HOP);
  }
  return filtered;
}

/** Run both implementations and assert identical id sequences. */
async function assertEquivalent(
  entityIds: number[],
  scope: TenantScope,
  asOf: Date | null = null,
): Promise<number[]> {
  const legacy = await legacyEdgesForEntities(db!, entityIds, asOf, scope);
  const current = await getEdgesForEntities(db!, entityIds, asOf, scope);
  const legacyIds = legacy.map((e) => e.id);
  const currentIds = current.map((e) => e.id);
  expect(currentIds).toEqual(legacyIds);
  return currentIds;
}

const orgScope = (t: Tenant): TenantScope => ({
  orgId: t.orgId,
  spaceId: t.spaceId,
  userId: t.userId,
});

describeDb('getEdgesForEntities — SQL bounds match the old JS pipeline', () => {
  test('null confidence is treated as 1.0 and kept', async () => {
    const a = await seedEntity(db!, tenant, 'alpha');
    const b = await seedEntity(db!, tenant, 'beta');
    const kept = await seedEdge(db!, tenant, {
      sourceEntityId: a,
      targetEntityId: b,
      confidence: null,
    });

    const ids = await assertEquivalent([a], orgScope(tenant));
    expect(ids).toEqual([kept]);
  });

  test('the confidence threshold boundary is inclusive on both sides', async () => {
    const a = await seedEntity(db!, tenant, 'alpha');
    const b = await seedEntity(db!, tenant, 'beta');
    // Exactly at the threshold must be KEPT (>=), just below must be dropped.
    const atThreshold = await seedEdge(db!, tenant, {
      sourceEntityId: a,
      targetEntityId: b,
      confidence: GRAPH_MIN_CONFIDENCE,
    });
    await seedEdge(db!, tenant, {
      sourceEntityId: a,
      targetEntityId: b,
      confidence: GRAPH_MIN_CONFIDENCE - 0.000_001,
    });
    const above = await seedEdge(db!, tenant, {
      sourceEntityId: a,
      targetEntityId: b,
      confidence: 0.95,
    });

    const ids = await assertEquivalent([a], orgScope(tenant));
    expect(new Set(ids)).toEqual(new Set([atThreshold, above]));
  });

  test('zero confidence is dropped', async () => {
    const a = await seedEntity(db!, tenant, 'alpha');
    const b = await seedEntity(db!, tenant, 'beta');
    await seedEdge(db!, tenant, {
      sourceEntityId: a,
      targetEntityId: b,
      confidence: 0,
    });

    expect(await assertEquivalent([a], orgScope(tenant))).toEqual([]);
  });

  test('ordering is effective-time desc then id desc, with valid_from winning', async () => {
    const a = await seedEntity(db!, tenant, 'alpha');
    const b = await seedEntity(db!, tenant, 'beta');
    const old = new Date('2026-01-01T00:00:00Z');
    const recent = new Date('2026-06-01T00:00:00Z');

    // Recorded recently but valid_from is old → must sort as OLD.
    const oldByValidFrom = await seedEdge(db!, tenant, {
      sourceEntityId: a,
      targetEntityId: b,
      validFrom: old,
      recordedAt: recent,
    });
    // No valid_from → falls back to recorded_at.
    const newByRecordedAt = await seedEdge(db!, tenant, {
      sourceEntityId: a,
      targetEntityId: b,
      validFrom: null,
      recordedAt: recent,
    });

    const ids = await assertEquivalent([a], orgScope(tenant));
    expect(ids).toEqual([newByRecordedAt, oldByValidFrom]);
  });

  test('ties on effective time break by id descending', async () => {
    const a = await seedEntity(db!, tenant, 'alpha');
    const b = await seedEntity(db!, tenant, 'beta');
    const same = new Date('2026-05-05T12:00:00Z');
    const first = await seedEdge(db!, tenant, {
      sourceEntityId: a, targetEntityId: b, recordedAt: same, validFrom: null,
    });
    const second = await seedEdge(db!, tenant, {
      sourceEntityId: a, targetEntityId: b, recordedAt: same, validFrom: null,
    });

    const ids = await assertEquivalent([a], orgScope(tenant));
    expect(ids).toEqual([second, first]);
  });

  test('a temporal asOf cutoff excludes later edges identically', async () => {
    const a = await seedEntity(db!, tenant, 'alpha');
    const b = await seedEntity(db!, tenant, 'beta');
    const before = await seedEdge(db!, tenant, {
      sourceEntityId: a, targetEntityId: b,
      recordedAt: new Date('2026-01-01T00:00:00Z'), validFrom: null,
    });
    await seedEdge(db!, tenant, {
      sourceEntityId: a, targetEntityId: b,
      recordedAt: new Date('2026-09-01T00:00:00Z'), validFrom: null,
    });

    const ids = await assertEquivalent(
      [a],
      orgScope(tenant),
      new Date('2026-06-01T00:00:00Z'),
    );
    expect(ids).toEqual([before]);
  });

  test('forgotten edges are excluded identically', async () => {
    const a = await seedEntity(db!, tenant, 'alpha');
    const b = await seedEntity(db!, tenant, 'beta');
    const live = await seedEdge(db!, tenant, { sourceEntityId: a, targetEntityId: b });
    await seedEdge(db!, tenant, {
      sourceEntityId: a, targetEntityId: b, forgotten: true,
    });

    expect(await assertEquivalent([a], orgScope(tenant))).toEqual([live]);
  });

  test('per-user visibility filtering is unchanged', async () => {
    const a = await seedEntity(db!, tenant, 'alpha');
    const b = await seedEntity(db!, tenant, 'beta');
    const orgVisible = await seedEdge(db!, tenant, {
      sourceEntityId: a, targetEntityId: b, visibility: 'org',
    });
    const mine = await seedEdge(db!, tenant, {
      sourceEntityId: a, targetEntityId: b,
      visibility: 'private', ownerUserId: tenant.userId,
    });
    await seedEdge(db!, tenant, {
      sourceEntityId: a, targetEntityId: b,
      visibility: 'private', ownerUserId: tenant.otherUserId,
    });

    const scoped: TenantScope = {
      ...orgScope(tenant),
      visibleUserIds: [tenant.userId],
    };
    const ids = await assertEquivalent([a], scoped);
    expect(new Set(ids)).toEqual(new Set([orgVisible, mine]));
  });

  test('cross-space and cross-org edges never appear', async () => {
    const a = await seedEntity(db!, tenant, 'alpha');
    const b = await seedEntity(db!, tenant, 'beta');
    await seedEdge(db!, tenant, { sourceEntityId: a, targetEntityId: b });

    const otherSpace: TenantScope = { ...orgScope(tenant), spaceId: tenant.spaceId + 999 };
    const otherOrg: TenantScope = { ...orgScope(tenant), orgId: tenant.orgId + 999 };
    expect(await assertEquivalent([a], otherSpace)).toEqual([]);
    expect(await assertEquivalent([a], otherOrg)).toEqual([]);
  });

  test('a high-degree entity is capped at exactly the same 200 edges', async () => {
    const hub = await seedEntity(db!, tenant, 'hub');
    const leaf = await seedEntity(db!, tenant, 'leaf');
    const memoryId = await seedMemory(db!, tenant, { content: 'hub fact' });

    // 250 edges past the cap, interleaved with 50 sub-threshold ones that must
    // be filtered BEFORE the cap applies — if the cap were applied first, the
    // two implementations would disagree here.
    const base = new Date('2026-03-01T00:00:00Z').getTime();
    const batch: Parameters<typeof seedEdges>[2] = [];
    for (let i = 0; i < 250; i++) {
      batch.push({
        sourceEntityId: hub,
        targetEntityId: leaf,
        memoryId,
        confidence: 0.9,
        validFrom: null,
        recordedAt: new Date(base + i * 60_000),
      });
      if (i % 5 === 0) {
        batch.push({
          sourceEntityId: hub,
          targetEntityId: leaf,
          memoryId,
          confidence: 0.1,
          validFrom: null,
          recordedAt: new Date(base + i * 60_000 + 1_000),
        });
      }
    }
    // One statement rather than 300 round-trips: same rows, same insertion
    // order, therefore the same ascending ids the tie-break depends on.
    await seedEdges(db!, tenant, batch);

    const ids = await assertEquivalent([hub], orgScope(tenant));
    expect(ids).toHaveLength(GRAPH_MAX_EDGES_PER_HOP);
  });

  test('an entity matched as edge TARGET is found, not just as source', async () => {
    const a = await seedEntity(db!, tenant, 'alpha');
    const b = await seedEntity(db!, tenant, 'beta');
    const inbound = await seedEdge(db!, tenant, {
      sourceEntityId: b,
      targetEntityId: a,
    });

    expect(await assertEquivalent([a], orgScope(tenant))).toEqual([inbound]);
  });

  test('an empty seed set short-circuits', async () => {
    expect(await getEdgesForEntities(db!, [], null, orgScope(tenant))).toEqual([]);
  });

  test('complete multi-hop traversal matches the legacy edge path', async () => {
    const alpha = await seedEntity(db!, tenant, 'alpha project');
    const beta = await seedEntity(db!, tenant, 'beta service');
    const gamma = await seedEntity(db!, tenant, 'gamma database');
    const delta = await seedEntity(db!, tenant, 'delta archive');
    const seed = await seedMemory(db!, tenant, { content: 'alpha seed memory' });
    const hopOne = await seedMemory(db!, tenant, { content: 'alpha to beta' });
    const hopTwo = await seedMemory(db!, tenant, { content: 'beta to gamma' });
    const cycle = await seedMemory(db!, tenant, { content: 'gamma to alpha cycle' });
    const future = await seedMemory(db!, tenant, { content: 'future edge' });
    const hidden = await seedMemory(db!, tenant, {
      content: 'other user private edge',
      visibility: 'private',
      ownerUserId: tenant.otherUserId,
    });
    await db!.execute(sql`
      insert into memory_entities (memory_id, entity_id)
      values (${seed}, ${alpha})`);

    await seedEdge(db!, tenant, {
      sourceEntityId: alpha,
      targetEntityId: beta,
      memoryId: hopOne,
      confidence: null,
      recordedAt: new Date('2026-01-01T00:00:00Z'),
    });
    await seedEdge(db!, tenant, {
      sourceEntityId: beta,
      targetEntityId: gamma,
      memoryId: hopTwo,
      confidence: 0.8,
      recordedAt: new Date('2026-02-01T00:00:00Z'),
    });
    await seedEdge(db!, tenant, {
      sourceEntityId: gamma,
      targetEntityId: alpha,
      memoryId: cycle,
      confidence: 0.7,
      recordedAt: new Date('2026-03-01T00:00:00Z'),
    });
    await seedEdge(db!, tenant, {
      sourceEntityId: gamma,
      targetEntityId: delta,
      memoryId: future,
      confidence: 0.9,
      recordedAt: new Date('2027-01-01T00:00:00Z'),
    });
    await seedEdge(db!, tenant, {
      sourceEntityId: beta,
      targetEntityId: delta,
      memoryId: hidden,
      confidence: 0.95,
      visibility: 'private',
      ownerUserId: tenant.otherUserId,
      recordedAt: new Date('2026-04-01T00:00:00Z'),
    });

    const scope: TenantScope = {
      ...orgScope(tenant),
      visibleUserIds: [tenant.userId],
    };
    const vectorStore = new MemoryVectorStore();
    const runTraversal = (
      options?: Parameters<typeof graphSearchWithStore>[8],
    ) => graphSearchWithStore(
      db!,
      vectorStore,
      'alpha',
      [1, 0],
      scope,
      20,
      new Date('2026-12-31T23:59:59Z'),
      3,
      options,
    );
    const legacy = await runTraversal({
      edgeLoader: legacyEdgesForEntities,
    });
    const current = await runTraversal();

    expect(current.map((candidate) => candidate.memoryId)).toEqual(
      legacy.map((candidate) => candidate.memoryId),
    );
    expect(current.map((candidate) => candidate.memoryId)).toContain(hopTwo);
    expect(current.map((candidate) => candidate.memoryId)).not.toContain(future);
    expect(current.map((candidate) => candidate.memoryId)).not.toContain(hidden);
    expect(current).toHaveLength(legacy.length);
    for (let index = 0; index < current.length; index += 1) {
      expect(current[index]!.score).toBeCloseTo(legacy[index]!.score, 8);
    }
  });
});
