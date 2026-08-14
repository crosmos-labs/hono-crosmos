import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  chunkMemories,
  chunks,
  dailySourceContentTypes,
  dailyUsage,
  recordIngestionUsage,
  sources,
  type Database,
} from '@crosmos/db';
import type { Logger, StageRecorder } from '@crosmos/observability';
import {
  announceSkip,
  getTestDb,
  resetTestData,
  seedMemory,
  seedTenant,
  type Tenant,
} from '@crosmos/test-support';
import { eq } from 'drizzle-orm';
import { recordIngestionUsageBestEffort } from '../src/usage';

const database: Database | null = await getTestDb();
if (database === null) announceSkip('usage-rollup.pg.test.ts');
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

function scope() {
  return { orgId: tenant.orgId, userId: tenant.userId, spaceId: tenant.spaceId };
}

describeDb('ingestion usage rollups', () => {
  test('continuation retries account a completed source and its memories once', async () => {
    const [source] = await database!.insert(sources).values({
      orgId: tenant.orgId,
      spaceId: tenant.spaceId,
      ownerUserId: tenant.userId,
      contentType: 'markdown',
      content: 'completed continuation fixture',
      tokenCount: 11,
      extractionStatus: 'completed',
    }).returning({ id: sources.id });
    const [chunk] = await database!.insert(chunks).values({
      orgId: tenant.orgId,
      spaceId: tenant.spaceId,
      sourceId: source!.id,
      content: 'fixture chunk',
    }).returning({ id: chunks.id });
    const firstMemoryId = await seedMemory(database!, tenant, { content: 'first result' });
    const secondMemoryId = await seedMemory(database!, tenant, { content: 'second result' });
    await database!.insert(chunkMemories).values([
      { chunkId: chunk!.id, memoryId: firstMemoryId },
      { chunkId: chunk!.id, memoryId: secondMemoryId },
    ]);

    const input = { tokens: 11, completedSourceIds: [source!.id], failedSourceIds: [] };
    await recordIngestionUsage(database!, scope(), input);
    await recordIngestionUsage(database!, scope(), input);

    const [usage] = await database!.select().from(dailyUsage);
    expect(usage).toMatchObject({
      tokensIngested: 11,
      sourcesIngested: 1,
      sourcesFailed: 0,
      memoriesCreated: 2,
    });
    const [contentType] = await database!.select().from(dailySourceContentTypes);
    expect(contentType).toMatchObject({ contentType: 'markdown', count: 1 });
    const [marked] = await database!.select({ meta: sources.meta }).from(sources)
      .where(eq(sources.id, source!.id));
    expect(marked!.meta).toEqual({ analytics_completion_recorded: true });
  });

  test('a partial job accounts completed and newly failed sources separately', async () => {
    const [completed, failed] = await database!.insert(sources).values([
      {
        orgId: tenant.orgId,
        spaceId: tenant.spaceId,
        ownerUserId: tenant.userId,
        content: 'completed source',
        tokenCount: 7,
        extractionStatus: 'completed',
      },
      {
        orgId: tenant.orgId,
        spaceId: tenant.spaceId,
        ownerUserId: tenant.userId,
        content: 'failed source',
        tokenCount: 5,
        extractionStatus: 'failed',
      },
    ]).returning({ id: sources.id });

    await recordIngestionUsage(database!, scope(), {
      tokens: 12,
      completedSourceIds: [completed!.id],
      failedSourceIds: [failed!.id],
    });
    await recordIngestionUsage(database!, scope(), {
      tokens: 12,
      completedSourceIds: [completed!.id],
      failedSourceIds: [failed!.id],
    });

    const [usage] = await database!.select().from(dailyUsage);
    expect(usage).toMatchObject({
      tokensIngested: 7,
      sourcesIngested: 1,
      sourcesFailed: 1,
      memoriesCreated: 0,
    });
    expect(usage!.sourcesIngested + usage!.sourcesFailed).toBe(2);
  });
});

test('a rollup write failure is logged and does not escape to the job caller', async () => {
  const warnings: Array<{ event: string; error: unknown }> = [];
  const logger = {
    warn(event: string, _fields: unknown, error: unknown) {
      warnings.push({ event, error });
    },
  } as unknown as Logger;
  const stages = {
    async time<T>(_stage: string, _fields: unknown, fn: () => Promise<T>) {
      return fn();
    },
  } as unknown as StageRecorder;
  const failure = new Error('forced rollup failure');
  const failingDatabase = {
    async transaction() { throw failure; },
  } as unknown as Database;

  await expect(recordIngestionUsageBestEffort({
    db: failingDatabase,
    scope: { orgId: 1, userId: 2, spaceId: 3 },
    input: { tokens: 1, completedSourceIds: [], failedSourceIds: [] },
    stages,
    logger,
  })).resolves.toBeUndefined();
  expect(warnings).toEqual([{ event: 'ingestion.record_tokens_failed', error: failure }]);
});
