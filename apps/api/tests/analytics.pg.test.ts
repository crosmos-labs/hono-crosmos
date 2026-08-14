import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  apiKeys,
  organizationMembers,
  recordIngestionUsage,
  sources,
  type Database,
} from '@crosmos/db';
import { announceSkip, getTestDb, resetTestData, seedTenant, type Tenant } from '@crosmos/test-support';
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
      (uuid, org_id, user_id, space_id, date, sources_ingested, memories_created)
    values (gen_random_uuid(), ${tenant.orgId}, ${tenant.userId}, ${tenant.spaceId}, current_date, 2, 7)`);
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
