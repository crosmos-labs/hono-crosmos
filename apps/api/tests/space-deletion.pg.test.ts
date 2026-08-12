/**
 * P1-A — deferred space deletion and retained usage history.
 *
 * The old `DELETE` hard-deleted the parent row immediately, which raced
 * in-flight ingestion (the cascade could remove rows a running job was writing),
 * cascaded away billing history, and made a failed external-vector purge
 * unrecoverable — the authoritative memory/entity ids were already gone.
 *
 * These are database-level behaviours (partial unique indexes, cascade vs
 * no-cascade, CAS predicates), so they run against real Postgres.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { type Database, memorySpaces } from '@crosmos/db';
import { eq, sql } from 'drizzle-orm';
import {
  countActiveJobsForSpace,
  countSpaces,
  deleteSpace,
  getSpaceById,
  getSpaceByName,
  getSpaceByUuid,
  listSpaces,
  listSpacesPendingDeletion,
  tombstoneSpace,
} from '../src/features/spaces/service';
import {
  announceSkip,
  getTestDb,
  resetTestData,
  seedEntity,
  seedMemory,
  seedTenant,
  type Tenant,
} from '@crosmos/test-support';

const db: Database | null = await getTestDb();
if (db === null) announceSkip('space-deletion.pg.test.ts');
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

async function createSpace(name: string): Promise<{ id: number; uuid: string }> {
  const [row] = await db!.execute<{ id: number; uuid: string }>(sql`
    insert into memory_spaces (uuid, org_id, name, user_id)
    values (gen_random_uuid(), ${tenant.orgId}, ${name}, ${tenant.userId})
    returning id, uuid`);
  return row!;
}

async function seedUsage(spaceId: number, tokens: number): Promise<void> {
  await db!.execute(sql`
    insert into daily_usage (uuid, org_id, user_id, space_id, date, tokens_ingested)
    values (gen_random_uuid(), ${tenant.orgId}, ${tenant.userId}, ${spaceId},
            current_date, ${tokens})`);
}

async function usageRowCount(spaceId: number): Promise<number> {
  const [row] = await db!.execute<{ c: number }>(
    sql`select count(*)::int as c from daily_usage where space_id = ${spaceId}`,
  );
  return row!.c;
}

async function backdateTombstone(spaceId: number, minutesAgo: number): Promise<void> {
  await db!.execute(sql`
    update memory_spaces
    set deleted_at = now() - (${minutesAgo} || ' minutes')::interval
    where id = ${spaceId}`);
}

const orgInput = (spaceId: number) => ({ orgId: tenant.orgId, spaceId });

describeDb('tombstoning', () => {
  test('a tombstoned space is absent from every normal read path', async () => {
    const space = await createSpace('doomed');

    expect(await getSpaceByUuid(db!, space.uuid)).not.toBeNull();
    expect(await tombstoneSpace(db!, orgInput(space.id))).toBe(true);

    expect(await getSpaceByUuid(db!, space.uuid)).toBeNull();
    expect(await getSpaceById(db!, orgInput(space.id))).toBeNull();
    expect(await getSpaceByName(db!, { orgId: tenant.orgId, name: 'doomed' })).toBeNull();
    // The tenant fixture's own space is still active, so assert on membership
    // rather than an empty list.
    const listed = await listSpaces(db!, { orgId: tenant.orgId });
    expect(listed.map((sp) => sp.id)).not.toContain(space.id);
  });

  test('the row still exists — this is logical, not physical, deletion', async () => {
    const space = await createSpace('doomed');
    await tombstoneSpace(db!, orgInput(space.id));

    const rows = await db!
      .select({ id: memorySpaces.id })
      .from(memorySpaces)
      .where(eq(memorySpaces.id, space.id));
    expect(rows).toHaveLength(1);
    // ...and is reachable through the explicit escape hatch the deletion path uses.
    expect(await getSpaceByUuid(db!, space.uuid, { includeDeleted: true })).not.toBeNull();
  });

  test('a tombstoned space stops counting against the org space quota', async () => {
    const a = await createSpace('a');
    await createSpace('b');
    expect(await countSpaces(db!, tenant.orgId)).toBe(3); // + the seeded space

    await tombstoneSpace(db!, orgInput(a.id));
    expect(await countSpaces(db!, tenant.orgId)).toBe(2);
  });

  test('repeated delete is idempotent and does not move the tombstone forward', async () => {
    const space = await createSpace('doomed');

    expect(await tombstoneSpace(db!, orgInput(space.id))).toBe(true);
    const [first] = await db!
      .select({ deletedAt: memorySpaces.deletedAt })
      .from(memorySpaces)
      .where(eq(memorySpaces.id, space.id));

    // Second call reports "nothing to do" rather than re-stamping. Re-stamping
    // would keep resetting the finalizer's grace period, so a repeatedly
    // deleted space would never be cleaned up.
    expect(await tombstoneSpace(db!, orgInput(space.id))).toBe(false);
    const [second] = await db!
      .select({ deletedAt: memorySpaces.deletedAt })
      .from(memorySpaces)
      .where(eq(memorySpaces.id, space.id));

    expect(second!.deletedAt!.getTime()).toBe(first!.deletedAt!.getTime());
  });

  test('another org cannot tombstone this org’s space', async () => {
    const space = await createSpace('doomed');
    expect(
      await tombstoneSpace(db!, { orgId: tenant.orgId + 999, spaceId: space.id }),
    ).toBe(false);
    expect(await getSpaceByUuid(db!, space.uuid)).not.toBeNull();
  });
});

describeDb('active-only name uniqueness', () => {
  test('two active spaces cannot share a name', async () => {
    await createSpace('shared');
    await expect(createSpace('shared')).rejects.toThrow();
  });

  test('a deleted name can be reused immediately, before cleanup runs', async () => {
    const first = await createSpace('recycled');
    await tombstoneSpace(db!, orgInput(first.id));

    // This is the point of the partial unique index: with a plain unique
    // constraint the name would stay reserved until the finalizer ran, so a
    // user could not recreate a space they had just deleted.
    const second = await createSpace('recycled');
    expect(second.id).not.toBe(first.id);

    // Only the live one is visible.
    const visible = await listSpaces(db!, { orgId: tenant.orgId, name: 'recycled' });
    expect(visible.map((s) => s.id)).toEqual([second.id]);
  });

  test('many tombstones of the same name can coexist', async () => {
    for (let i = 0; i < 3; i++) {
      const s = await createSpace('churn');
      await tombstoneSpace(db!, orgInput(s.id));
    }
    // The uniqueness predicate only covers deleted_at IS NULL, so the tombstones
    // do not collide with each other.
    const live = await createSpace('churn');
    expect(live.id).toBeGreaterThan(0);
  });
});

describeDb('finalizer eligibility', () => {
  test('a fresh tombstone is not yet eligible', async () => {
    const space = await createSpace('doomed');
    await tombstoneSpace(db!, orgInput(space.id));

    const pending = await listSpacesPendingDeletion(db!, {
      graceMs: 10 * 60_000,
      limit: 10,
    });
    expect(pending).toHaveLength(0);
  });

  test('a tombstone past the grace period is eligible', async () => {
    const space = await createSpace('doomed');
    await tombstoneSpace(db!, orgInput(space.id));
    await backdateTombstone(space.id, 30);

    const pending = await listSpacesPendingDeletion(db!, {
      graceMs: 10 * 60_000,
      limit: 10,
    });
    expect(pending.map((p) => p.id)).toEqual([space.id]);
  });

  test('active spaces are never eligible', async () => {
    await createSpace('alive');
    expect(
      await listSpacesPendingDeletion(db!, { graceMs: 0, limit: 10 }),
    ).toHaveLength(0);
  });

  test('eligibility is oldest-first and bounded', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const s = await createSpace(`old-${i}`);
      await tombstoneSpace(db!, orgInput(s.id));
      // Oldest first: space 0 is the most stale.
      await backdateTombstone(s.id, 100 - i);
      ids.push(s.id);
    }
    const pending = await listSpacesPendingDeletion(db!, {
      graceMs: 10 * 60_000,
      limit: 3,
    });
    expect(pending.map((p) => p.id)).toEqual(ids.slice(0, 3));
  });

  test('an in-flight ingestion job blocks finalization', async () => {
    const space = await createSpace('busy');
    await db!.execute(sql`
      insert into ingestion_jobs (id, org_id, user_id, space_id, status, source_ids)
      values (gen_random_uuid(), ${tenant.orgId}, ${tenant.userId},
              ${space.id}, 'processing', '[]'::jsonb)`);

    expect(await countActiveJobsForSpace(db!, space.id)).toBe(1);

    await db!.execute(
      sql`update ingestion_jobs set status = 'completed' where space_id = ${space.id}`,
    );
    expect(await countActiveJobsForSpace(db!, space.id)).toBe(0);
  });
});

describeDb('physical deletion and usage retention', () => {
  test('finalization removes the space and its memories', async () => {
    const space = await createSpace('doomed');
    const spaceTenant = { ...tenant, spaceId: space.id };
    await seedMemory(db!, spaceTenant, { content: 'a fact' });
    await tombstoneSpace(db!, orgInput(space.id));

    const { deleted, memoryIds } = await deleteSpace(db!, orgInput(space.id));
    expect(deleted).toBe(true);
    expect(memoryIds).toHaveLength(1);

    const rows = await db!
      .select({ id: memorySpaces.id })
      .from(memorySpaces)
      .where(eq(memorySpaces.id, space.id));
    expect(rows).toHaveLength(0);
  });

  test('daily_usage SURVIVES physical deletion of its space', async () => {
    const space = await createSpace('doomed');
    await seedUsage(space.id, 1234);
    expect(await usageRowCount(space.id)).toBe(1);

    await tombstoneSpace(db!, orgInput(space.id));
    expect(await deleteSpace(db!, orgInput(space.id))).toMatchObject({ deleted: true });

    // The whole point of dropping the FK: billing history outlives the space,
    // so an org's recorded usage never decreases.
    expect(await usageRowCount(space.id)).toBe(1);
  });

  test('a usage write succeeds AFTER the space row is gone', async () => {
    const space = await createSpace('doomed');
    await tombstoneSpace(db!, orgInput(space.id));
    await deleteSpace(db!, orgInput(space.id));

    // A late search or ingestion settling after deletion must not fail on a
    // foreign key that no longer exists.
    await seedUsage(space.id, 7);
    expect(await usageRowCount(space.id)).toBe(1);
  });

  test('anything committed before the tombstone is still included in the purge', async () => {
    const space = await createSpace('doomed');
    const spaceTenant = { ...tenant, spaceId: space.id };
    await seedMemory(db!, spaceTenant, { content: 'written before delete' });
    await seedMemory(db!, spaceTenant, { content: 'also before delete' });

    await tombstoneSpace(db!, orgInput(space.id));
    const { memoryIds } = await deleteSpace(db!, orgInput(space.id));

    // Ids are collected BEFORE the cascade. Necessary but not sufficient for a
    // retryable purge — see the vector-purge ordering block below for the other
    // half.
    expect(memoryIds).toHaveLength(2);
  });

  test('deleting one space leaves its sibling untouched', async () => {
    const doomed = await createSpace('doomed');
    const keeper = await createSpace('keeper');
    await seedMemory(db!, { ...tenant, spaceId: keeper.id }, { content: 'keep me' });
    await seedUsage(keeper.id, 99);

    await tombstoneSpace(db!, orgInput(doomed.id));
    await deleteSpace(db!, orgInput(doomed.id));

    expect(await getSpaceByUuid(db!, keeper.uuid)).not.toBeNull();
    expect(await usageRowCount(keeper.id)).toBe(1);
  });
});

/**
 * Vector-purge ordering.
 *
 * This block exists because the finalizer shipped with the order INVERTED: it
 * deleted the parent row and then purged vectors from the collected ids. Every
 * test above still passed, because none of them supplied a vector store, let
 * alone a failing one. The result was silent and unrecoverable — a purge failure
 * left vectors in Qdrant with the tombstone already gone, and `VectorStore`
 * exposes `deleteByIds` only, so nothing could enumerate them afterwards.
 *
 * The invariant: on failure the space row SURVIVES, because the row is the only
 * handle the next sweep has.
 */
describeDb('vector purge ordering', () => {
  /** Records what was purged, and whether the space row still existed at the time. */
  async function spaceExists(spaceId: number): Promise<boolean> {
    const rows = await db!
      .select({ id: memorySpaces.id })
      .from(memorySpaces)
      .where(eq(memorySpaces.id, spaceId));
    return rows.length > 0;
  }

  test('vectors are purged while the space row still exists', async () => {
    const space = await createSpace('doomed');
    await seedMemory(db!, { ...tenant, spaceId: space.id }, { content: 'a fact' });
    await tombstoneSpace(db!, orgInput(space.id));

    const existedDuringPurge: boolean[] = [];
    await deleteSpace(db!, {
      ...orgInput(space.id),
      purgeVectors: async () => {
        existedDuringPurge.push(await spaceExists(space.id));
      },
    });

    // The ordering assertion. Under the inverted implementation this is false:
    // the row is already gone by the time the purge runs, so a failure has
    // nothing left to retry from.
    expect(existedDuringPurge).toEqual([true]);
    expect(await spaceExists(space.id)).toBe(false);
  });

  test('a failed purge leaves the space row and the tombstone intact', async () => {
    const space = await createSpace('doomed');
    await seedMemory(db!, { ...tenant, spaceId: space.id }, { content: 'a fact' });
    await tombstoneSpace(db!, orgInput(space.id));
    await backdateTombstone(space.id, 30);

    await expect(
      deleteSpace(db!, {
        ...orgInput(space.id),
        purgeVectors: async () => {
          throw new Error('qdrant unavailable');
        },
      }),
    ).rejects.toThrow('qdrant unavailable');

    // Row survives, so the next sweep can retry. The memories survive with it —
    // a half-deleted space would be worse than an undeleted one.
    expect(await spaceExists(space.id)).toBe(true);
    const [row] = await db!.execute<{ c: number }>(
      sql`select count(*)::int as c from memories where space_id = ${space.id}`,
    );
    expect(row!.c).toBe(1);
  });

  test('the space is still eligible for the next sweep after a failed purge', async () => {
    const space = await createSpace('doomed');
    await tombstoneSpace(db!, orgInput(space.id));
    await backdateTombstone(space.id, 30);

    await expect(
      deleteSpace(db!, {
        ...orgInput(space.id),
        purgeVectors: async () => {
          throw new Error('qdrant unavailable');
        },
      }),
    ).rejects.toThrow();

    // The actual retry mechanism: the finalizer re-discovers it by tombstone.
    const pending = await listSpacesPendingDeletion(db!, {
      graceMs: 10 * 60_000,
      limit: 10,
    });
    expect(pending.map((p) => p.id)).toContain(space.id);
  });

  test('the retry re-derives the same ids and succeeds', async () => {
    const space = await createSpace('doomed');
    const spaceTenant = { ...tenant, spaceId: space.id };
    const m1 = await seedMemory(db!, spaceTenant, { content: 'one' });
    const m2 = await seedMemory(db!, spaceTenant, { content: 'two' });
    const e1 = await seedEntity(db!, spaceTenant, 'Priya');
    await tombstoneSpace(db!, orgInput(space.id));

    const attempts: Array<{ memoryIds: number[]; entityIds: number[] }> = [];
    let failNext = true;
    const purge = async (ids: { memoryIds: number[]; entityIds: number[] }) => {
      attempts.push(ids);
      if (failNext) {
        failNext = false;
        throw new Error('transient');
      }
    };

    await expect(
      deleteSpace(db!, { ...orgInput(space.id), purgeVectors: purge }),
    ).rejects.toThrow('transient');
    const second = await deleteSpace(db!, { ...orgInput(space.id), purgeVectors: purge });

    expect(second.deleted).toBe(true);
    expect(attempts).toHaveLength(2);
    // Identical id sets across attempts — the property that makes the retry
    // idempotent rather than a partial second pass.
    expect(attempts[0]).toEqual(attempts[1]!);
    expect(attempts[1]!.memoryIds.sort()).toEqual([m1, m2].sort());
    expect(attempts[1]!.entityIds).toEqual([e1]);
    expect(await spaceExists(space.id)).toBe(false);
  });

  test('entity vectors are purged too, not just memories', async () => {
    const space = await createSpace('doomed');
    const spaceTenant = { ...tenant, spaceId: space.id };
    await seedMemory(db!, spaceTenant, { content: 'a fact' });
    await seedEntity(db!, spaceTenant, 'Blue Harbor');
    await tombstoneSpace(db!, orgInput(space.id));

    const seen: Array<{ memoryIds: number[]; entityIds: number[] }> = [];
    await deleteSpace(db!, {
      ...orgInput(space.id),
      purgeVectors: async (ids) => {
        seen.push(ids);
      },
    });

    // Entities are space-scoped and cascade with the space, so their vectors
    // orphan exactly like memory vectors do.
    expect(seen[0]!.memoryIds).toHaveLength(1);
    expect(seen[0]!.entityIds).toHaveLength(1);
  });

  test('omitting the purge callback deletes the row (pg-column vector store)', async () => {
    const space = await createSpace('doomed');
    await tombstoneSpace(db!, orgInput(space.id));

    // `persistsInColumn: true` needs no external purge; the cascade covers it.
    const result = await deleteSpace(db!, orgInput(space.id));
    expect(result.deleted).toBe(true);
    expect(await spaceExists(space.id)).toBe(false);
  });
});
