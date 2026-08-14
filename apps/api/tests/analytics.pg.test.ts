import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  apiKeys,
  organizationMembers,
  recordIngestionUsage,
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
import { sql } from 'drizzle-orm';
import type { HonoEnv } from '../src/bindings';
import { hashApiKey } from '../src/features/auth/key-format';

mock.module('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(public ctx: unknown, public env: unknown) {}
  },
}));
const { app } = await import('../src/index');

const db: Database | null = await getTestDb();
if (db === null) announceSkip('analytics.pg.test.ts');
const describeDb = db === null ? describe.skip : describe;

let tenant: Tenant;
let ownSpaceUuid: string;
let otherSpaceUuid: string;
let crossOrgSpaceUuid: string;
const orgKey = 'csk_analytics_org_test';
const scopedKey = 'csk_analytics_space_test';

const kvData = new Map<string, string>();
const kv = {
  async get(key: string, type?: string) {
    const value = kvData.get(key) ?? null;
    return type === 'json' && value !== null ? JSON.parse(value) : value;
  },
  async put(key: string, value: string) { kvData.set(key, value); },
  async delete(key: string) { kvData.delete(key); },
} as unknown as KVNamespace;

const env = {
  HYPERDRIVE: { connectionString: process.env.TEST_DATABASE_URL ?? 'postgresql://crosmos:crosmos@localhost:5433/crosmos_test' },
  API_KEY_CACHE: kv,
  ENVIRONMENT: 'development',
} as unknown as HonoEnv['Bindings'];

const executionCtx = {
  waitUntil(promise: Promise<unknown>) { void promise; },
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

async function request(path: string, key: string) {
  return app.request(path, { headers: { Authorization: `Bearer ${key}` } }, env, executionCtx);
}

afterAll(async () => { if (db) await resetTestData(db); });
beforeEach(async () => {
  if (!db) return;
  kvData.clear();
  await resetTestData(db);
  tenant = await seedTenant(db);
  await db.insert(organizationMembers).values({ orgId: tenant.orgId, userId: tenant.userId, role: 'owner' });
  const spaces = await db.execute<{ id: number; uuid: string }>(sql`
    insert into memory_spaces (uuid, org_id, name, user_id)
    values (gen_random_uuid(), ${tenant.orgId}, 'analytics-other', ${tenant.userId})
    returning id, uuid`);
  const own = await db.execute<{ uuid: string }>(sql`select uuid from memory_spaces where id = ${tenant.spaceId}`);
  ownSpaceUuid = own[0]!.uuid;
  otherSpaceUuid = spaces[0]!.uuid;
  await db.insert(apiKeys).values([
    { orgId: tenant.orgId, userId: tenant.userId, name: 'org', keyPrefix: orgKey.slice(0, 12), keyHash: await hashApiKey(orgKey) },
    { orgId: tenant.orgId, userId: tenant.userId, spaceId: tenant.spaceId, name: 'scoped', keyPrefix: scopedKey.slice(0, 12), keyHash: await hashApiKey(scopedKey) },
  ]);
  await db.execute(sql`
    insert into daily_usage
      (uuid, org_id, user_id, space_id, date, tokens_ingested, search_queries,
       sources_ingested, memories_created)
    values (gen_random_uuid(), ${tenant.orgId}, ${tenant.userId}, ${tenant.spaceId},
      current_date, 123, 5, 2, 7)`);
  await db.insert(sources).values([
    {
      orgId: tenant.orgId,
      spaceId: tenant.spaceId,
      ownerUserId: tenant.userId,
      content: 'completed analytics source one',
      extractionStatus: 'completed',
    },
    {
      orgId: tenant.orgId,
      spaceId: tenant.spaceId,
      ownerUserId: tenant.userId,
      content: 'completed analytics source two',
      extractionStatus: 'completed',
    },
  ]);
  for (let index = 0; index < 7; index += 1) {
    await seedMemory(db, tenant, { content: `analytics memory ${index}` });
  }
  const cross = await db.execute<{ uuid: string }>(sql`
    with u as (
      insert into users (uuid, email, name, is_active)
      values (gen_random_uuid(), 'cross@test.local', 'Cross', true) returning id
    ), o as (
      insert into organizations (uuid, slug, name, plan, is_personal, created_by_user_id)
      select gen_random_uuid(), 'cross-org', 'Cross Org', 'free', false, id from u returning id
    )
    insert into memory_spaces (uuid, org_id, name, user_id)
    select gen_random_uuid(), o.id, 'cross-space', u.id from o, u returning uuid`);
  crossOrgSpaceUuid = cross[0]!.uuid;
});

describeDb('analytics HTTP routes', () => {
  test('accepts 30, 60, and 90 days and rejects any other window', async () => {
    for (const days of [30, 60, 90]) {
      const response = await request(`/api/v1/analytics/summary?days=${days}`, orgKey);
      expect(response.status).toBe(200);
      expect((await response.json() as { days: number }).days).toBe(days);
    }
    expect((await request('/api/v1/analytics/summary?days=31', orgKey)).status).toBe(400);
  });

  test('org key sees its totals but never another organization', async () => {
    const response = await request('/api/v1/analytics/summary', orgKey);
    expect(response.status).toBe(200);
    expect((await response.json() as { totals: { sources_ingested: number } }).totals.sources_ingested).toBe(2);
    expect((await request(`/api/v1/spaces/${crossOrgSpaceUuid}/analytics`, orgKey)).status).toBe(404);
  });

  test('analytics and usage report the same token and search rollups', async () => {
    const analyticsResponse = await request('/api/v1/analytics/summary', orgKey);
    const usageResponse = await request('/api/v1/usage', orgKey);
    expect(analyticsResponse.status).toBe(200);
    expect(usageResponse.status).toBe(200);

    const analytics = await analyticsResponse.json() as {
      totals: { tokens_ingested: number; search_queries: number };
    };
    const usage = await usageResponse.json() as {
      tokens: { used: number };
      queries: { used: number };
    };
    expect(analytics.totals.tokens_ingested).toBe(123);
    expect(analytics.totals.search_queries).toBe(5);
    expect(usage.tokens.used).toBe(analytics.totals.tokens_ingested);
    expect(usage.queries.used).toBe(analytics.totals.search_queries);
  });

  test('rollup totals reconcile with authoritative current-window rows', async () => {
    const response = await request('/api/v1/analytics/summary', orgKey);
    expect(response.status).toBe(200);
    const analytics = await response.json() as {
      totals: { sources_ingested: number; memories_created: number };
    };
    const [counts] = await db!.execute<{ source_count: number; memory_count: number }>(sql`
      select
        (select count(*)::int from sources
          where org_id = ${tenant.orgId}
            and extraction_status = 'completed'
            and created_at::date = current_date) as source_count,
        (select count(*)::int from memories
          where org_id = ${tenant.orgId}
            and created_at::date = current_date) as memory_count`);
    expect(analytics.totals.sources_ingested).toBe(counts!.source_count);
    expect(analytics.totals.memories_created).toBe(counts!.memory_count);
  });

  test('tombstoned large spaces keep history in org totals but leave the breakdown', async () => {
    const otherSpaces = await db!.execute<{ id: number }>(sql`
      select id from memory_spaces where uuid = ${otherSpaceUuid}`);
    const otherSpaceId = otherSpaces[0]?.id;
    if (otherSpaceId === undefined) throw new Error('Expected the secondary test space');
    await db!.execute(sql`
      insert into daily_usage
        (uuid, org_id, user_id, space_id, date, sources_ingested, memories_created)
      values
        (gen_random_uuid(), ${tenant.orgId}, ${tenant.userId}, ${otherSpaceId},
         current_date, 3, 4)`);
    await db!.execute(sql`
      insert into memories
        (uuid, org_id, space_id, owner_user_id, content, memory_type)
      select gen_random_uuid(), ${tenant.orgId}, ${otherSpaceId}, ${tenant.userId},
        'large-corpus-' || value, 'semantic'
      from generate_series(1, 2000) value`);
    await db!.execute(sql`
      update memory_spaces set deleted_at = now() where id = ${otherSpaceId}`);

    const started = performance.now();
    const response = await request('/api/v1/analytics/summary', orgKey);
    const elapsedMs = performance.now() - started;
    expect(response.status).toBe(200);
    const analytics = await response.json() as {
      totals: { sources_ingested: number; memories_created: number };
      spaces: Array<{ space_id: string }>;
    };
    expect(analytics.totals).toMatchObject({ sources_ingested: 5, memories_created: 11 });
    expect(analytics.spaces.map((space) => space.space_id)).toEqual([ownSpaceUuid]);
    expect(elapsedMs).toBeLessThan(2_000);
    expect((await request(`/api/v1/spaces/${otherSpaceUuid}/analytics`, orgKey)).status).toBe(404);
  });

  test('space-scoped key sees only its own space', async () => {
    expect((await request(`/api/v1/spaces/${ownSpaceUuid}/analytics`, scopedKey)).status).toBe(200);
    expect((await request('/api/v1/analytics/summary', scopedKey)).status).toBe(403);
    expect((await request(`/api/v1/spaces/${otherSpaceUuid}/analytics`, scopedKey)).status).toBe(403);
  });

  test('rollup markers preserve legacy non-object source metadata', async () => {
    const [source] = await db!.insert(sources).values({
      orgId: tenant.orgId,
      spaceId: tenant.spaceId,
      ownerUserId: tenant.userId,
      content: 'legacy metadata regression fixture',
      extractionStatus: 'completed',
      tokenCount: 4,
      meta: ['legacy-array-value'],
    }).returning({ id: sources.id });

    await recordIngestionUsage(db!, {
      orgId: tenant.orgId,
      userId: tenant.userId,
      spaceId: tenant.spaceId,
    }, {
      tokens: 4,
      completedSourceIds: [source!.id],
      failedSourceIds: [],
    });

    const [updated] = await db!.select({ meta: sources.meta })
      .from(sources)
      .where(sql`${sources.id} = ${source!.id}`);
    expect(updated!.meta).toEqual({
      analytics_completion_recorded: true,
      legacy_value: ['legacy-array-value'],
    });
  });
});
