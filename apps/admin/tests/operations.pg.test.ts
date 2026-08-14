import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  adminAuditLog,
  apiKeys,
  memorySpaces,
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
