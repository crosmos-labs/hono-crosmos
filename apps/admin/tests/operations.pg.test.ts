import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  adminAuditLog,
  apiKeys,
  dailyUsage,
  ingestionJobs,
  memorySpaces,
  organizationMembers,
  organizations,
  sources,
  type Database,
} from '@crosmos/db';
import { announceSkip, getTestDb, resetTestData, seedTenant, type Tenant } from '@crosmos/test-support';
import { eq, sql } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import type { Env } from '../src/bindings';
import { app } from '../src/index';

const originalFetch = globalThis.fetch;
let privateKey: KeyLike;
let publicJwk: Awaited<ReturnType<typeof exportJWK>>;
const database: Database | null = await getTestDb();
if (database === null) announceSkip('operations.pg.test.ts');
const describeDb = database === null ? describe.skip : describe;

let tenant: Tenant;
let orgUuid: string;
let spaceUuid: string;
let sourceUuid: string;
let apiKeyUuid: string;
const deletedCacheKeys: string[] = [];

const limiter = {
  idFromName() { return {} as DurableObjectId; },
  get() { return { fetch: async () => Response.json({ allowed: true }) }; },
} as unknown as DurableObjectNamespace;

const cache = {
  async get() { return null; },
  async put() {},
  async delete(key: string) { deletedCacheKeys.push(key); },
} as unknown as KVNamespace;

const env = {
  HYPERDRIVE: {
    connectionString: process.env.TEST_DATABASE_URL
      ?? 'postgresql://crosmos:crosmos@localhost:5433/crosmos_test_admin',
  },
  API_KEY_CACHE: cache,
  ADMIN_RATE_LIMITER: limiter,
  ENVIRONMENT: 'test',
  ACCESS_TEAM_DOMAIN: 'admin-pg-test.example',
  ACCESS_AUD: 'admin-pg-audience',
  ADMIN_ALLOWED_EMAILS: 'operator@example.com',
} as unknown as Env;

async function accessToken() {
  return new SignJWT({ email: 'operator@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'admin-pg-key' })
    .setIssuer('https://admin-pg-test.example')
    .setAudience('admin-pg-audience')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

async function request(path: string, method = 'GET', body?: unknown) {
  const headers = new Headers({ 'Cf-Access-Jwt-Assertion': await accessToken() });
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env);
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  publicJwk = await exportJWK(pair.publicKey);
  publicJwk.kid = 'admin-pg-key';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === 'https://admin-pg-test.example/cdn-cgi/access/certs') {
      return Response.json({ keys: [publicJwk] });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  if (database) await resetTestData(database);
});

beforeEach(async () => {
  if (!database) return;
  deletedCacheKeys.length = 0;
  await resetTestData(database);
  tenant = await seedTenant(database);
  const [org] = await database.select({ uuid: organizations.uuid })
    .from(organizations).where(eq(organizations.id, tenant.orgId));
  const [space] = await database.select({ uuid: memorySpaces.uuid })
    .from(memorySpaces).where(eq(memorySpaces.id, tenant.spaceId));
  const [source] = await database.insert(sources).values({
    orgId: tenant.orgId,
    spaceId: tenant.spaceId,
    ownerUserId: tenant.userId,
    content: 'admin redrive fixture',
    extractionStatus: 'pending',
  }).returning({ uuid: sources.uuid });
  const [apiKey] = await database.insert(apiKeys).values({
    orgId: tenant.orgId,
    userId: tenant.userId,
    keyPrefix: 'csk_admin_pg',
    keyHash: 'a'.repeat(64),
    name: 'Admin fixture key',
  }).returning({ uuid: apiKeys.uuid });
  orgUuid = org!.uuid;
  spaceUuid = space!.uuid;
  sourceUuid = source!.uuid;
  apiKeyUuid = apiKey!.uuid;
});

describeDb('admin audited operations', () => {
  test('overview, lookup, and ingestion health reconcile without returning content', async () => {
    await database!.insert(dailyUsage).values({
      orgId: tenant.orgId,
      userId: tenant.userId,
      spaceId: tenant.spaceId,
      date: sql`current_date`,
      searchQueries: 1,
    });
    const [overviewResponse, userResponse] = await Promise.all([
      request('/admin/overview'),
      request('/admin/users?email=owner@test.local'),
    ]);
    expect(overviewResponse.status).toBe(200);
    expect(await overviewResponse.json()).toMatchObject({
      totals: {
        users: 2,
        organizations: 1,
        active_spaces: 1,
        sources: 1,
        memories: 0,
      },
      new: { users: 2, organizations: 1, spaces: 1, sources: 1, memories: 0 },
      previous_window_new: { users: 0, organizations: 0, spaces: 0, sources: 0, memories: 0 },
      active: { users: 1, organizations: 1, spaces: 1 },
      previous_window_active: { users: 0, organizations: 0, spaces: 0 },
      deltas: { users: 2, organizations: 1, spaces: 1, sources: 1, memories: 0 },
    });
    expect(userResponse.status).toBe(200);
    expect(await userResponse.json()).toMatchObject({
      users: [{ email: 'owner@test.local', name: 'Owner', active: true }],
    });

    await database!.insert(ingestionJobs).values([
      {
        orgId: tenant.orgId,
        spaceId: tenant.spaceId,
        userId: tenant.userId,
        sourceIds: [],
        status: 'failed',
        completedAt: new Date(),
      },
      {
        orgId: tenant.orgId,
        spaceId: tenant.spaceId,
        userId: tenant.userId,
        sourceIds: [],
        status: 'processing',
        startedAt: new Date(Date.now() - 20 * 60_000),
      },
    ]);
    await database!.update(memorySpaces).set({ deletedAt: new Date() })
      .where(eq(memorySpaces.id, tenant.spaceId));
    const healthResponse = await request('/admin/ingestion-health?limit=500');
    expect(healthResponse.status).toBe(200);
    const health = await healthResponse.json() as {
      failed: unknown[];
      stuck: unknown[];
      tombstoned_spaces: number;
      pending_deletions: unknown[];
      limit: number;
    };
    expect(health).toMatchObject({ tombstoned_spaces: 1, limit: 100 });
    expect(health.failed).toHaveLength(1);
    expect(health.stuck).toHaveLength(1);
    expect(health.pending_deletions).toHaveLength(1);
    expect(JSON.stringify(health)).not.toContain('admin redrive fixture');
  });

  test('org detail is bounded, enriched, and omits customer content and credentials', async () => {
    await database!.insert(organizationMembers).values({
      orgId: tenant.orgId,
      userId: tenant.userId,
      role: 'owner',
    });
    await database!.insert(dailyUsage).values({
      orgId: tenant.orgId,
      userId: tenant.userId,
      spaceId: tenant.spaceId,
      date: sql`current_date`,
      tokensIngested: 321,
      searchQueries: 12,
      sourcesIngested: 3,
      sourcesFailed: 1,
      memoriesCreated: 9,
    });
    await database!.insert(ingestionJobs).values({
      orgId: tenant.orgId,
      spaceId: tenant.spaceId,
      userId: tenant.userId,
      sourceIds: [],
      status: 'processing',
      currentStage: 'embedding',
    });
    await database!.update(organizations).set({
      grantedPlan: 'pro',
      grantedPlanExpiresAt: new Date(Date.now() + 86_400_000),
    }).where(eq(organizations.id, tenant.orgId));
    await database!.execute(sql`
      insert into memory_spaces (uuid, org_id, name, user_id)
      select gen_random_uuid(), ${tenant.orgId}, 'bounded-space-' || value, ${tenant.userId}
      from generate_series(1, 101) value`);

    const response = await request(`/admin/orgs/${orgUuid}?limit=500`);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      organization: {
        effective_plan: string;
        entitlements: Record<string, number>;
      };
      month_to_date: {
        tokens: { used: number; limit: number };
        queries: { used: number; limit: number };
        sources_ingested: number;
        sources_failed: number;
        memories_created: number;
      };
      members: { items: unknown[]; next_offset: number | null };
      spaces: { items: unknown[]; next_offset: number | null };
      api_keys: { items: unknown[]; next_offset: number | null };
      recent_ingestion_jobs: { items: unknown[]; next_offset: number | null };
      pagination: { limit: number; offset: number };
    };
    expect(body.organization.effective_plan).toBe('pro');
    expect(body.organization.entitlements.monthly_tokens_ingested).toBe(40_000_000);
    expect(body.month_to_date).toEqual({
      tokens: { used: 321, limit: 40_000_000 },
      queries: { used: 12, limit: 200_000 },
      sources_ingested: 3,
      sources_failed: 1,
      memories_created: 9,
    });
    expect(body.pagination).toEqual({ limit: 100, offset: 0 });
    expect(body.members.items).toHaveLength(1);
    expect(body.spaces.items).toHaveLength(100);
    expect(body.spaces.next_offset).toBe(100);
    expect(body.api_keys.items).toHaveLength(1);
    expect(body.recent_ingestion_jobs.items).toHaveLength(1);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('admin redrive fixture');
    expect(serialized).not.toContain('keyHash');
    expect(serialized).not.toContain('key_hash');
    expect(serialized).not.toContain('sourceIds');
    expect(serialized).not.toContain('source_ids');
  });

  test('grant and revoke preserve billing fields and audit every mutation', async () => {
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    expect((await request(`/admin/orgs/${orgUuid}/grant`, 'PUT', {
      plan: 'pro', expires_at: expiresAt,
    })).status).toBe(200);

    await database!.update(organizations).set({
      plan: 'developer',
      subscriptionStatus: 'active',
      polarCustomerId: 'polar-customer',
      polarSubscriptionId: 'polar-subscription',
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    }).where(eq(organizations.id, tenant.orgId));

    const [duringGrant] = await database!.select().from(organizations)
      .where(eq(organizations.id, tenant.orgId));
    expect(duringGrant).toMatchObject({
      plan: 'developer',
      grantedPlan: 'pro',
      subscriptionStatus: 'active',
      polarCustomerId: 'polar-customer',
      polarSubscriptionId: 'polar-subscription',
    });

    expect((await request(`/admin/orgs/${orgUuid}/grant`, 'DELETE')).status).toBe(200);
    expect((await request(`/admin/orgs/${orgUuid}/grant`, 'DELETE')).status).toBe(200);
    const [afterRevoke] = await database!.select().from(organizations)
      .where(eq(organizations.id, tenant.orgId));
    expect(afterRevoke).toMatchObject({
      plan: 'developer',
      grantedPlan: null,
      grantedPlanExpiresAt: null,
      subscriptionStatus: 'active',
      polarCustomerId: 'polar-customer',
      polarSubscriptionId: 'polar-subscription',
    });

    const audits = await database!.select().from(adminAuditLog)
      .where(eq(adminAuditLog.targetId, orgUuid));
    expect(audits.map((row) => row.action)).toEqual([
      'plan_grant.upsert',
      'plan_grant.revoke',
      'plan_grant.revoke',
    ]);
    expect(audits[0]!.before).toEqual({ granted_plan: null, expires_at: null });
    expect(audits[0]!.after).toMatchObject({ granted_plan: 'pro' });
  });

  test('an audit insert failure rolls back the grant mutation', async () => {
    await database!.execute(sql.raw(`
      CREATE FUNCTION fail_test_admin_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'plan_grant.upsert' THEN
          RAISE EXCEPTION 'forced audit failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_test_admin_audit
      BEFORE INSERT ON admin_audit_log
      FOR EACH ROW EXECUTE FUNCTION fail_test_admin_audit();
    `));
    try {
      const response = await request(`/admin/orgs/${orgUuid}/grant`, 'PUT', {
        plan: 'pro', expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      });
      expect(response.status).toBe(500);
      const [org] = await database!.select({
        grantedPlan: organizations.grantedPlan,
        grantedPlanExpiresAt: organizations.grantedPlanExpiresAt,
      }).from(organizations).where(eq(organizations.id, tenant.orgId));
      expect(org).toEqual({ grantedPlan: null, grantedPlanExpiresAt: null });
      expect(await database!.select().from(adminAuditLog)).toHaveLength(0);
    } finally {
      await database!.execute(sql.raw(`
        DROP TRIGGER IF EXISTS fail_test_admin_audit ON admin_audit_log;
        DROP FUNCTION IF EXISTS fail_test_admin_audit();
      `));
    }
  });

  test('cache invalidation and source requeue are repeatable and audited', async () => {
    expect((await request(`/admin/api-keys/${apiKeyUuid}/invalidate-cache`, 'POST')).status).toBe(200);
    expect((await request(`/admin/api-keys/${apiKeyUuid}/invalidate-cache`, 'POST')).status).toBe(200);
    expect(deletedCacheKeys).toEqual([`apikey:${'a'.repeat(64)}`, `apikey:${'a'.repeat(64)}`]);

    expect((await request(`/admin/sources/${sourceUuid}/requeue`, 'POST')).status).toBe(200);
    expect((await request(`/admin/sources/${sourceUuid}/requeue`, 'POST')).status).toBe(200);
    const [source] = await database!.select().from(sources).where(eq(sources.uuid, sourceUuid));
    expect(source).toMatchObject({
      extractionStatus: 'failed',
      meta: { admin_redrive_requested: true },
    });
    const audits = await database!.select({ action: adminAuditLog.action })
      .from(adminAuditLog)
      .where(sql`${adminAuditLog.targetId} IN (${apiKeyUuid}, ${sourceUuid})`);
    expect(audits.map((row) => row.action).sort()).toEqual([
      'api_key.cache_invalidated',
      'api_key.cache_invalidated',
      'source.requeue_requested',
      'source.requeue_requested',
    ]);

    await database!.update(sources).set({ meta: { redrive_attempts: 5 } })
      .where(eq(sources.uuid, sourceUuid));
    expect((await request(`/admin/sources/${sourceUuid}/requeue`, 'POST')).status).toBe(409);
  });

  test('restore is audited and refuses expired or name-conflicting tombstones', async () => {
    await database!.update(memorySpaces).set({ deletedAt: new Date(Date.now() - 86_400_000) })
      .where(eq(memorySpaces.id, tenant.spaceId));
    expect((await request(`/admin/spaces/${spaceUuid}/restore`, 'POST')).status).toBe(200);
    expect((await request(`/admin/spaces/${spaceUuid}/restore`, 'POST')).status).toBe(200);
    const restoreAudits = await database!.select({ action: adminAuditLog.action })
      .from(adminAuditLog).where(eq(adminAuditLog.targetId, spaceUuid));
    expect(restoreAudits.map((row) => row.action)).toEqual(['space.restore', 'space.restore_noop']);

    await database!.update(memorySpaces).set({ deletedAt: new Date(Date.now() - 31 * 86_400_000) })
      .where(eq(memorySpaces.id, tenant.spaceId));
    expect((await request(`/admin/spaces/${spaceUuid}/restore`, 'POST')).status).toBe(409);

    await database!.update(memorySpaces).set({ deletedAt: new Date(Date.now() - 86_400_000) })
      .where(eq(memorySpaces.id, tenant.spaceId));
    await database!.insert(memorySpaces).values({
      orgId: tenant.orgId,
      userId: tenant.userId,
      name: 'test-space',
    });
    expect((await request(`/admin/spaces/${spaceUuid}/restore`, 'POST')).status).toBe(409);
  });
});
