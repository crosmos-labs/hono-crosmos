/**
 * Job lifecycle guards (P1-A), against real Postgres.
 *
 * These exist because a mutation test found the gap: removing the
 * compare-and-set terminal guard from `updateJobStatus` — a safety guard added
 * for deferred space deletion and shipped to production — broke **zero** tests.
 * The guard is what stops a heartbeat resurrecting a cancelled job, and it also
 * doubles as the mid-source cancellation detector, so a silent regression here
 * means a deleted space keeps being written to.
 *
 * The claim/lease logic is exercised here too: it is a conditional UPDATE whose
 * correctness depends entirely on Postgres serialising it, which no fake can
 * demonstrate.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from '@crosmos/db';
import {
  announceSkip,
  getTestDb,
  jobStatus,
  resetTestData,
  seedJob,
  seedSpace,
  seedTenant,
  type Tenant,
} from '@crosmos/test-support';
import {
  claimJob,
  isJobCancelled,
  isSpaceActive,
  resetJobForRetry,
  updateJobStatus,
} from '../src/job-store';

const db: Database | null = await getTestDb();
if (db === null) announceSkip('job-store.pg.test.ts');
const describeDb = db === null ? describe.skip : describe;

const LEASE_MS = 5 * 60_000;
let tenant: Tenant;

afterAll(async () => {
  if (db !== null) await resetTestData(db);
});

beforeEach(async () => {
  if (db === null) return;
  await resetTestData(db);
  tenant = await seedTenant(db);
});

describeDb('updateJobStatus — compare-and-set on terminality', () => {
  test('a heartbeat cannot resurrect a CANCELLED job', async () => {
    const jobId = await seedJob(db!, tenant, { status: 'cancelled' });

    // Exactly what the per-source and per-chunk heartbeats write.
    const applied = await updateJobStatus(db!, jobId, 'processing', {
      stage: 'source 1/3',
    });

    expect(applied).toBe(false);
    expect(await jobStatus(db!, jobId)).toBe('cancelled');
  });

  test.each(['completed', 'partial', 'failed', 'cancelled'] as const)(
    'terminal status %s is final — nothing may move it',
    async (terminal) => {
      const jobId = await seedJob(db!, tenant, { status: terminal });

      expect(await updateJobStatus(db!, jobId, 'processing')).toBe(false);
      expect(await updateJobStatus(db!, jobId, 'pending')).toBe(false);
      expect(await updateJobStatus(db!, jobId, 'completed')).toBe(false);
      expect(await jobStatus(db!, jobId)).toBe(terminal);
    },
  );

  test('a non-terminal job still accepts writes — the guard is not a blanket freeze', async () => {
    const jobId = await seedJob(db!, tenant, { status: 'processing' });

    expect(await updateJobStatus(db!, jobId, 'processing', { stage: 'src 1/2' })).toBe(true);
    expect(await updateJobStatus(db!, jobId, 'completed')).toBe(true);
    expect(await jobStatus(db!, jobId)).toBe('completed');
  });

  test('the refusal is the mid-source cancellation signal', async () => {
    // The pipeline relies on `applied === false` to know it should stop, rather
    // than issuing a second query per chunk.
    const jobId = await seedJob(db!, tenant, { status: 'processing' });
    expect(await updateJobStatus(db!, jobId, 'processing')).toBe(true);

    await db!.execute(
      (await import('drizzle-orm')).sql`update ingestion_jobs set status='cancelled' where id=${jobId}`,
    );
    expect(await updateJobStatus(db!, jobId, 'processing')).toBe(false);
  });

  test('an unknown job id reports not-applied rather than throwing', async () => {
    expect(
      await updateJobStatus(db!, '00000000-0000-0000-0000-000000000000', 'processing'),
    ).toBe(false);
  });
});

describeDb('claimJob — the single coordination point between RPC and queue', () => {
  test('a pending job is claimed exactly once under concurrency', async () => {
    const jobId = await seedJob(db!, tenant, { status: 'pending' });

    // Both triggers race. Postgres serialises the conditional UPDATE, so
    // exactly one may win — this is the guarantee that stops double-processing.
    const results = await Promise.all([
      claimJob(db!, jobId, LEASE_MS),
      claimJob(db!, jobId, LEASE_MS),
      claimJob(db!, jobId, LEASE_MS),
    ]);

    expect(results.filter((r) => r === 'claimed')).toHaveLength(1);
    expect(results.filter((r) => r === 'in_flight')).toHaveLength(2);
  });

  test('a job with a LIVE lease is refused', async () => {
    const jobId = await seedJob(db!, tenant, {
      status: 'processing',
      startedMinutesAgo: 1,
    });
    expect(await claimJob(db!, jobId, LEASE_MS)).toBe('in_flight');
  });

  test('a job whose lease EXPIRED is reclaimed — abandoned work recovers', async () => {
    const jobId = await seedJob(db!, tenant, {
      status: 'processing',
      startedMinutesAgo: 30,
    });
    expect(await claimJob(db!, jobId, LEASE_MS)).toBe('claimed');
  });

  test.each(['completed', 'failed', 'cancelled'] as const)(
    'a %s job is never re-claimed',
    async (status) => {
      const jobId = await seedJob(db!, tenant, { status });
      expect(await claimJob(db!, jobId, LEASE_MS)).toBe('terminal');
    },
  );

  test('a missing job reports not_found', async () => {
    expect(
      await claimJob(db!, '00000000-0000-0000-0000-000000000000', LEASE_MS),
    ).toBe('not_found');
  });

  test('claiming re-stamps started_at, so the heartbeat lease actually renews', async () => {
    const jobId = await seedJob(db!, tenant, {
      status: 'processing',
      startedMinutesAgo: 30,
    });
    expect(await claimJob(db!, jobId, LEASE_MS)).toBe('claimed');
    // Now the lease is fresh, so a second trigger must be refused.
    expect(await claimJob(db!, jobId, LEASE_MS)).toBe('in_flight');
  });
});

describeDb('isJobCancelled / resetJobForRetry', () => {
  test('cancellation is observed', async () => {
    const live = await seedJob(db!, tenant, { status: 'processing' });
    const dead = await seedJob(db!, tenant, { status: 'cancelled' });

    expect(await isJobCancelled(db!, live)).toBe(false);
    expect(await isJobCancelled(db!, dead)).toBe(true);
  });

  test('resetJobForRetry only touches a job still processing', async () => {
    const processing = await seedJob(db!, tenant, { status: 'processing' });
    expect(await resetJobForRetry(db!, processing)).toBe(true);
    expect(await jobStatus(db!, processing)).toBe('pending');

    // A job another trigger already finished must not be dragged back.
    const done = await seedJob(db!, tenant, { status: 'completed' });
    expect(await resetJobForRetry(db!, done)).toBe(false);
    expect(await jobStatus(db!, done)).toBe('completed');
  });

  test('a cancelled job is not reset back into the queue', async () => {
    const cancelled = await seedJob(db!, tenant, { status: 'cancelled' });
    expect(await resetJobForRetry(db!, cancelled)).toBe(false);
    expect(await jobStatus(db!, cancelled)).toBe('cancelled');
  });
});

describeDb('isSpaceActive — the ingestion-side deletion fence', () => {
  test('an active space is writable', async () => {
    expect(await isSpaceActive(db!, tenant.spaceId)).toBe(true);
  });

  test('a tombstoned space is fenced off', async () => {
    const doomed = await seedSpace(db!, tenant, 'doomed', { deleted: true });
    expect(await isSpaceActive(db!, doomed)).toBe(false);
  });

  test('a space that never existed is not active', async () => {
    expect(await isSpaceActive(db!, 999_999)).toBe(false);
  });

  test('tombstoning one space does not fence its siblings', async () => {
    const doomed = await seedSpace(db!, tenant, 'doomed', { deleted: true });
    const keeper = await seedSpace(db!, tenant, 'keeper');

    expect(await isSpaceActive(db!, doomed)).toBe(false);
    expect(await isSpaceActive(db!, keeper)).toBe(true);
    expect(await isSpaceActive(db!, tenant.spaceId)).toBe(true);
  });
});
