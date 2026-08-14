import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { memoryEntities, type Database } from '@crosmos/db';
import {
  announceSkip,
  getTestDb,
  resetTestData,
  seedEntity,
  seedMemory,
  seedTenant,
  type Tenant,
} from '@crosmos/test-support';
import { getEntityIdsLinkedToVisibleMemories } from '../src/features/search/candidates';

const database: Database | null = await getTestDb();
if (database === null) announceSkip('graph-visibility.pg.test.ts');
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

describeDb('graph seed visibility', () => {
  test('keeps only entities linked to memories visible to the caller', async () => {
    const visibleEntityId = await seedEntity(database!, tenant, 'visible entity');
    const hiddenEntityId = await seedEntity(database!, tenant, 'hidden entity');
    const visibleMemoryId = await seedMemory(database!, tenant, {
      content: 'caller private memory',
      visibility: 'private',
      ownerUserId: tenant.userId,
    });
    const hiddenMemoryId = await seedMemory(database!, tenant, {
      content: 'other user private memory',
      visibility: 'private',
      ownerUserId: tenant.otherUserId,
    });
    await database!.insert(memoryEntities).values([
      { memoryId: visibleMemoryId, entityId: visibleEntityId },
      { memoryId: hiddenMemoryId, entityId: hiddenEntityId },
    ]);

    const visible = await getEntityIdsLinkedToVisibleMemories(
      database!,
      {
        orgId: tenant.orgId,
        spaceId: tenant.spaceId,
        userId: tenant.userId,
        visibleUserIds: [tenant.userId],
      },
      [visibleEntityId, hiddenEntityId],
    );

    expect(visible).toEqual(new Set([visibleEntityId]));
  });
});
