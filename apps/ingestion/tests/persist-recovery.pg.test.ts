import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  chunkMemories,
  chunks,
  memories,
  sources,
  type Database,
} from '@crosmos/db';
import {
  announceSkip,
  getTestDb,
  resetTestData,
  seedMemory,
  seedTenant,
  type Tenant,
} from '@crosmos/test-support';
import type { VectorStore } from '@crosmos/vector';
import { asc, eq } from 'drizzle-orm';
import { purgeSourceArtifacts } from '../src/ingestion/pipeline';

const database: Database | null = await getTestDb();
if (database === null) announceSkip('persist-recovery.pg.test.ts');
const describeDb = database === null ? describe.skip : describe;
let tenant: Tenant;

beforeEach(async () => {
  if (!database) return;
  await resetTestData(database);
  tenant = await seedTenant(database);
});

afterAll(async () => {
  if (database) await resetTestData(database);
});

async function seedCommittedWindow() {
  const [source] = await database!.insert(sources).values({
    orgId: tenant.orgId,
    spaceId: tenant.spaceId,
    ownerUserId: tenant.userId,
    content: 'two committed chunks',
    extractionStatus: 'processing',
  }).returning({ id: sources.id });
  const chunkRows = await database!.insert(chunks).values([
    {
      orgId: tenant.orgId,
      spaceId: tenant.spaceId,
      sourceId: source!.id,
      sequence: 0,
      content: 'checkpointed chunk',
    },
    {
      orgId: tenant.orgId,
      spaceId: tenant.spaceId,
      sourceId: source!.id,
      sequence: 1,
      content: 'partially committed tail',
    },
  ]).returning({ id: chunks.id, sequence: chunks.sequence });
  const checkpointMemoryId = await seedMemory(
    database!, tenant, { content: 'checkpointed memory' },
  );
  const tailMemoryId = await seedMemory(database!, tenant, { content: 'tail memory' });
  const memoryIds = [checkpointMemoryId, tailMemoryId] as const;
  await database!.insert(chunkMemories).values(chunkRows.map((chunk) => ({
    chunkId: chunk.id,
    memoryId: memoryIds[chunk.sequence]!,
  })));
  return { sourceId: source!.id, memoryIds };
}

describeDb('bounded persistence recovery', () => {
  test('a vector failure leaves the real database tail discoverable for retry', async () => {
    const { sourceId, memoryIds } = await seedCommittedWindow();
    let deleteCalls = 0;
    const vectorStore = {
      persistsInColumn: false,
      async deleteByIds(_collection: 'memories' | 'entities', ids: number[]) {
        deleteCalls += 1;
        expect(ids).toEqual([memoryIds[1]]);
        if (deleteCalls === 1) throw new Error('forced vector delete failure');
      },
    } as unknown as VectorStore;

    await expect(
      purgeSourceArtifacts(database!, vectorStore, sourceId, 1),
    ).rejects.toThrow('forced vector delete failure');

    expect(await database!.select({ sequence: chunks.sequence }).from(chunks)
      .where(eq(chunks.sourceId, sourceId)).orderBy(asc(chunks.sequence)))
      .toEqual([{ sequence: 0 }, { sequence: 1 }]);
    expect(await database!.select({ memoryId: chunkMemories.memoryId }).from(chunkMemories)
      .orderBy(asc(chunkMemories.memoryId)))
      .toEqual(memoryIds.map((memoryId) => ({ memoryId })));

    expect(await purgeSourceArtifacts(database!, vectorStore, sourceId, 1)).toBe(1);
    expect(await database!.select({ sequence: chunks.sequence }).from(chunks)
      .where(eq(chunks.sourceId, sourceId)))
      .toEqual([{ sequence: 0 }]);
    expect(await database!.select({ memoryId: chunkMemories.memoryId }).from(chunkMemories))
      .toEqual([{ memoryId: memoryIds[0] }]);
    expect(await database!.select({ id: memories.id }).from(memories).orderBy(asc(memories.id)))
      .toEqual([{ id: memoryIds[0] }]);
  });
});
