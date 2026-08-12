/**
 * P1-A × redrive interaction.
 *
 * The re-drive sweep mints fresh ingestion jobs for sources that never reached a
 * terminal state. It selected purely from `sources`, with no knowledge of
 * whether the owning space still exists — so deleting a space that held a stuck
 * source put the two sweeps in a loop against each other:
 *
 *   redrive (every 15m) creates a job → the worker's `isSpaceActive` fence
 *   cancels it → `countActiveJobsForSpace` was non-zero in between, so the
 *   finalizer skipped the space → repeat until the source burns its re-drive
 *   budget and pages as `ingestion.sources_abandoned`.
 *
 * No data is corrupted, which is why it went unnoticed; the space simply never
 * finalizes, and the eventual alert blames data loss for a deliberate delete.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from '@crosmos/db';
import { sql } from 'drizzle-orm';
import { redriveStuckSources } from '../src/features/maintenance/redrive';
import { tombstoneSpace } from '../src/features/spaces/service';
import {
  announceSkip,
  getTestDb,
  resetTestData,
  seedTenant,
  type Tenant,
} from '@crosmos/test-support';
import type { Env } from '../src/bindings';

const db: Database | null = await getTestDb();
if (db === null) announceSkip('redrive-tombstone.pg.test.ts');
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
 * Enough Env for the candidate query and its logging. The sweep returns before
 * touching the job store or queue when there are no candidates, which is
 * precisely the path under test.
 */
const env = { ENVIRONMENT: 'test' } as unknown as Env;

/** A source stuck in `processing` long enough to be re-drive eligible. */
async function seedStuckSource(spaceId: number): Promise<number> {
  const [row] = await db!.execute<{ id: number }>(sql`
    insert into sources
      (uuid, org_id, space_id, owner_user_id, content_type, content,
       extraction_status, created_at, updated_at)
    values
      (gen_random_uuid(), ${tenant.orgId}, ${spaceId}, ${tenant.userId},
       'text', 'stuck content', 'processing', now() - interval '2 hours',
       now() - interval '2 hours')
    returning id`);
  return row!.id;
}

describeDb('redrive excludes tombstoned spaces', () => {
  test('a stuck source in an ACTIVE space is a candidate', async () => {
    await seedStuckSource(tenant.spaceId);

    const result = await redriveStuckSources(db!, env);

    // The positive control. Without it, the test below would pass just as well
    // against a query that returns nothing for any input.
    expect(result.candidates).toBe(1);
  });

  test('a stuck source in a TOMBSTONED space is not a candidate', async () => {
    await seedStuckSource(tenant.spaceId);
    await tombstoneSpace(db!, { orgId: tenant.orgId, spaceId: tenant.spaceId });

    const result = await redriveStuckSources(db!, env);

    expect(result.candidates).toBe(0);
    expect(result.jobsCreated).toBe(0);
  });

  test('no job is created for a tombstoned space, so finalization is not blocked', async () => {
    await seedStuckSource(tenant.spaceId);
    await tombstoneSpace(db!, { orgId: tenant.orgId, spaceId: tenant.spaceId });

    await redriveStuckSources(db!, env);

    // The consequence that actually mattered: a non-terminal job here makes
    // `countActiveJobsForSpace` non-zero and the finalizer skips this space on
    // every sweep, forever.
    const [row] = await db!.execute<{ c: number }>(sql`
      select count(*)::int as c from ingestion_jobs
      where space_id = ${tenant.spaceId} and status in ('pending','processing')`);
    expect(row!.c).toBe(0);
  });

  test('tombstoning one space does not hide a sibling space’s stuck source', async () => {
    const [sibling] = await db!.execute<{ id: number }>(sql`
      insert into memory_spaces (uuid, org_id, name, user_id)
      values (gen_random_uuid(), ${tenant.orgId}, 'sibling', ${tenant.userId})
      returning id`);
    await seedStuckSource(tenant.spaceId);
    await seedStuckSource(sibling!.id);
    await tombstoneSpace(db!, { orgId: tenant.orgId, spaceId: tenant.spaceId });

    const result = await redriveStuckSources(db!, env);

    // The join must exclude the tombstoned space only — an inner join on the
    // wrong column would silently drop everything.
    expect(result.candidates).toBe(1);
  });

  test('a budget-exhausted source in a tombstoned space is not marked abandoned', async () => {
    const id = await seedStuckSource(tenant.spaceId);
    await db!.execute(sql`
      update sources set meta = '{"redrive_attempts": 5}'::jsonb where id = ${id}`);
    await tombstoneSpace(db!, { orgId: tenant.orgId, spaceId: tenant.spaceId });

    const result = await redriveStuckSources(db!, env);

    // `markedExhausted` fires an ERROR log and a paging metric meaning "we gave
    // up on user data". A deliberately deleted space is not that, and paging on
    // it would erode trust in the one alert that must stay meaningful.
    expect(result.markedExhausted).toBe(0);
  });
});
