/**
 * P1-D — provenance split from full source content.
 *
 * The old single query joined `chunk_memories → chunks → sources` for EVERY
 * fused candidate and selected `sources.content` — the entire raw source — even
 * though at most `topK` candidates are ever returned. But the source metadata
 * could not simply move after selection: `session_id` drives session-diverse
 * selection, so identity has to load up front while content does not.
 *
 * The compatibility contract is strict, so this compares the split
 * implementation against the original combined query on the same fixture:
 * the same memory→source mapping, the same deterministic first-source rule, and
 * byte-identical `source` strings.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { type Database, chunkMemories, chunks, sources } from '@crosmos/db';
import type { TenantScope } from '@crosmos/types';
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { sourceVisibilityClause } from '../src/lib/scope';
import {
  attachCandidateProvenance,
  attachSourceContent,
} from '../src/features/search/candidates';
import type { RankedCandidate } from '../src/features/search/types';
import { SourceSignal } from '../src/features/search/types';
import {
  announceSkip,
  getTestDb,
  resetTestData,
  seedMemory,
  seedTenant,
  type Tenant,
} from './helpers/test-db';

const db: Database | null = await getTestDb();
if (db === null) announceSkip('source-provenance.pg.test.ts');
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

/** The pre-change combined query, kept as the reference implementation. */
async function legacyAttachSourceText(
  database: Database,
  scope: TenantScope,
  candidateLookup: Map<number, RankedCandidate>,
): Promise<void> {
  const ids = [...candidateLookup.keys()];
  if (ids.length === 0) return;

  const sourceConditions: (SQL | undefined)[] = [
    eq(sources.orgId, scope.orgId),
    eq(sources.spaceId, scope.spaceId),
    sourceVisibilityClause(scope),
  ];

  const rows = await database
    .select({
      memoryId: chunkMemories.memoryId,
      content: sources.content,
      sourceId: sources.id,
      sourceUuid: sources.uuid,
      sourceMeta: sources.meta,
    })
    .from(chunkMemories)
    .innerJoin(chunks, eq(chunks.id, chunkMemories.chunkId))
    .innerJoin(sources, eq(sources.id, chunks.sourceId))
    .where(and(...sourceConditions, inArray(chunkMemories.memoryId, ids)))
    .orderBy(asc(chunkMemories.memoryId), asc(sources.id), asc(chunks.sequence));

  const seen = new Set<number>();
  for (const row of rows) {
    if (seen.has(row.memoryId)) continue;
    seen.add(row.memoryId);
    const candidate = candidateLookup.get(row.memoryId);
    if (candidate) {
      candidate.sourceChunk = row.content;
      candidate.sourceId = row.sourceId;
      candidate.sourceUuid = row.sourceUuid;
      const meta = row.sourceMeta as Record<string, unknown> | null;
      candidate.sessionId = typeof meta?.session_id === 'string' ? meta.session_id : null;
    }
  }
}

function candidate(memoryId: number): RankedCandidate {
  return {
    memoryId,
    uuid: '',
    content: '',
    memoryType: 'semantic',
    ownerUserId: tenant.userId,
    orgId: tenant.orgId,
    spaceId: tenant.spaceId,
    importanceScore: 0.5,
    createdAt: new Date(),
    recordedAt: new Date(),
    accessFrequency: 0,
    lastAccessedAt: new Date(),
    eventTime: null,
    rank: 1,
    score: 1,
    source: SourceSignal.SEMANTIC,
    sourceChunk: null,
    sourceId: null,
    sourceUuid: null,
    sessionId: null,
  };
}

const lookupOf = (ids: number[]) =>
  new Map(ids.map((id) => [id, candidate(id)] as const));

async function seedSource(options: {
  content: string;
  sessionId?: string | null;
  visibility?: 'private' | 'org';
  ownerUserId?: number;
}): Promise<number> {
  const meta =
    options.sessionId === undefined || options.sessionId === null
      ? null
      : JSON.stringify({ session_id: options.sessionId });
  const [row] = await db!.execute<{ id: number }>(sql`
    insert into sources (uuid, org_id, space_id, owner_user_id, visibility,
                         content_type, content, extraction_status, meta)
    values (gen_random_uuid(), ${tenant.orgId}, ${tenant.spaceId},
            ${options.ownerUserId ?? tenant.userId}, ${options.visibility ?? 'org'},
            'text', ${options.content}, 'completed', ${meta}::jsonb)
    returning id`);
  return row!.id;
}

async function linkMemoryToSource(
  memoryId: number,
  sourceId: number,
  sequence: number,
): Promise<void> {
  const [chunk] = await db!
    .insert(chunks)
    .values({
      orgId: tenant.orgId,
      spaceId: tenant.spaceId,
      sourceId,
      sequence,
      content: `chunk ${sequence}`,
    })
    .returning({ id: chunks.id });
  await db!.insert(chunkMemories).values({ chunkId: chunk!.id, memoryId });
}

const orgScope = (t: Tenant): TenantScope => ({
  orgId: t.orgId,
  spaceId: t.spaceId,
  userId: t.userId,
});

/** Run both paths over the same candidate ids and compare the resulting fields. */
async function assertEquivalent(
  memoryIds: number[],
  scope: TenantScope,
): Promise<Map<number, RankedCandidate>> {
  const legacy = lookupOf(memoryIds);
  await legacyAttachSourceText(db!, scope, legacy);

  const current = lookupOf(memoryIds);
  await attachCandidateProvenance(db!, scope, current);
  // Content arrives after selection; here "selection" is every candidate.
  await attachSourceContent(db!, scope, [...current.values()]);

  for (const id of memoryIds) {
    const a = legacy.get(id)!;
    const b = current.get(id)!;
    expect({
      sourceId: b.sourceId,
      sourceUuid: b.sourceUuid,
      sessionId: b.sessionId,
      sourceChunk: b.sourceChunk,
    }).toEqual({
      sourceId: a.sourceId,
      sourceUuid: a.sourceUuid,
      sessionId: a.sessionId,
      sourceChunk: a.sourceChunk,
    });
  }
  return current;
}

describeDb('candidate provenance and source content', () => {
  test('source id, uuid, session id and content all match the combined query', async () => {
    const memoryId = await seedMemory(db!, tenant, { content: 'a fact' });
    const sourceId = await seedSource({
      content: 'The full original source text.',
      sessionId: 'sess-1',
    });
    await linkMemoryToSource(memoryId, sourceId, 0);

    const result = await assertEquivalent([memoryId], orgScope(tenant));
    expect(result.get(memoryId)!.sourceChunk).toBe('The full original source text.');
    expect(result.get(memoryId)!.sessionId).toBe('sess-1');
  });

  test('the source string is byte-identical, including awkward content', async () => {
    const tricky = 'Ünïcødé — "quotes", \n newlines, \t tabs, and emoji 🎯 ✅';
    const memoryId = await seedMemory(db!, tenant, { content: 'a fact' });
    const sourceId = await seedSource({ content: tricky, sessionId: 'sess-2' });
    await linkMemoryToSource(memoryId, sourceId, 0);

    const result = await assertEquivalent([memoryId], orgScope(tenant));
    expect(result.get(memoryId)!.sourceChunk).toBe(tricky);
  });

  test('the deterministic first-source rule survives: lowest source id wins', async () => {
    const memoryId = await seedMemory(db!, tenant, { content: 'cited twice' });
    const first = await seedSource({ content: 'FIRST source', sessionId: 'sess-a' });
    const second = await seedSource({ content: 'SECOND source', sessionId: 'sess-b' });
    // Link the HIGHER source id first, so insertion order cannot be what decides.
    await linkMemoryToSource(memoryId, second, 0);
    await linkMemoryToSource(memoryId, first, 0);

    const result = await assertEquivalent([memoryId], orgScope(tenant));
    expect(result.get(memoryId)!.sourceId).toBe(first);
    expect(result.get(memoryId)!.sourceChunk).toBe('FIRST source');
    expect(result.get(memoryId)!.sessionId).toBe('sess-a');
  });

  test('within one source the lowest chunk sequence wins', async () => {
    const memoryId = await seedMemory(db!, tenant, { content: 'cited twice in one source' });
    const sourceId = await seedSource({ content: 'one source', sessionId: 'sess-c' });
    await linkMemoryToSource(memoryId, sourceId, 5);
    await linkMemoryToSource(memoryId, sourceId, 1);

    await assertEquivalent([memoryId], orgScope(tenant));
  });

  test('a null session id stays null rather than becoming a string', async () => {
    const memoryId = await seedMemory(db!, tenant, { content: 'no session' });
    const sourceId = await seedSource({ content: 'sourceless session' });
    await linkMemoryToSource(memoryId, sourceId, 0);

    const result = await assertEquivalent([memoryId], orgScope(tenant));
    expect(result.get(memoryId)!.sessionId).toBeNull();
  });

  test('a memory with no source link keeps every field null', async () => {
    const memoryId = await seedMemory(db!, tenant, { content: 'orphan' });
    const result = await assertEquivalent([memoryId], orgScope(tenant));
    const c = result.get(memoryId)!;
    expect(c.sourceId).toBeNull();
    expect(c.sourceUuid).toBeNull();
    expect(c.sourceChunk).toBeNull();
    expect(c.sessionId).toBeNull();
  });

  test('a source the caller cannot see leaks neither text nor identity', async () => {
    const memoryId = await seedMemory(db!, tenant, { content: 'visible memory' });
    const hidden = await seedSource({
      content: 'SECRET source text',
      visibility: 'private',
      ownerUserId: tenant.otherUserId,
    });
    await linkMemoryToSource(memoryId, hidden, 0);

    const scoped: TenantScope = {
      ...orgScope(tenant),
      visibleUserIds: [tenant.userId],
    };
    const result = await assertEquivalent([memoryId], scoped);
    expect(result.get(memoryId)!.sourceChunk).toBeNull();
    expect(result.get(memoryId)!.sourceId).toBeNull();
  });

  test('many candidates across shared and distinct sources all match', async () => {
    const shared = await seedSource({ content: 'shared source', sessionId: 'sess-shared' });
    const ids: number[] = [];
    for (let i = 0; i < 12; i++) {
      const memoryId = await seedMemory(db!, tenant, { content: `fact ${i}` });
      const sourceId =
        i % 3 === 0
          ? shared
          : await seedSource({ content: `source for ${i}`, sessionId: `sess-${i}` });
      await linkMemoryToSource(memoryId, sourceId, 0);
      ids.push(memoryId);
    }

    const result = await assertEquivalent(ids, orgScope(tenant));
    expect(result.size).toBe(12);
    expect([...result.values()].every((c) => c.sourceChunk !== null)).toBe(true);
  });

  test('provenance alone never loads content — that is the whole point', async () => {
    const memoryId = await seedMemory(db!, tenant, { content: 'a fact' });
    const sourceId = await seedSource({ content: 'heavy source body', sessionId: 's' });
    await linkMemoryToSource(memoryId, sourceId, 0);

    const lookup = lookupOf([memoryId]);
    await attachCandidateProvenance(db!, orgScope(tenant), lookup);

    // Identity is present so session-diverse selection can run...
    expect(lookup.get(memoryId)!.sourceId).toBe(sourceId);
    expect(lookup.get(memoryId)!.sessionId).toBe('s');
    // ...but the expensive column is still untouched.
    expect(lookup.get(memoryId)!.sourceChunk).toBeNull();
  });

  test('content loading is a no-op when no candidate has a source', async () => {
    const memoryId = await seedMemory(db!, tenant, { content: 'orphan' });
    const list = [candidate(memoryId)];
    await attachSourceContent(db!, orgScope(tenant), list);
    expect(list[0]!.sourceChunk).toBeNull();
  });
});
