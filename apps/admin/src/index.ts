import {
  adminAuditLog,
  apiKeys,
  createDb,
  ingestionJobs,
  memories,
  memorySpaces,
  organizations,
  sources,
  users,
} from '@crosmos/db';
import { createLogger } from '@crosmos/observability';
import { invalidateApiKeyCacheHash, invalidateEntitlementCache } from '@crosmos/runtime';
import { and, count, desc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AdminEnv } from './bindings';
import { requireAdmin } from './auth';

export { AdminRateLimiterDO } from './rate-limiter';

export const app = new Hono<AdminEnv>();
app.use('*', async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set('requestId', requestId);
  c.header('X-Request-Id', requestId);
  await next();
});
app.get('/health', (c) => c.json({ status: 'ok' }));
app.use('/admin/*', requireAdmin);
app.get('/admin/whoami', (c) => c.json({ email: c.var.actorEmail }));

function db(c: Context<AdminEnv>) {
  return createDb(c.env.HYPERDRIVE.connectionString);
}
function positiveInt(value: string | undefined, fallback: number, max: number) {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

app.get('/admin/overview', async (c) => {
  const database = db(c);
  const days = positiveInt(c.req.query('days'), 30, 90);
  const since = new Date(Date.now() - days * 86_400_000);
  const [userTotal, orgTotal, spaceTotal, sourceTotal, memoryTotal, newUsers, newOrgs] = await Promise.all([
    database.select({ count: count() }).from(users),
    database.select({ count: count() }).from(organizations),
    database.select({ count: count() }).from(memorySpaces).where(sql`${memorySpaces.deletedAt} IS NULL`),
    database.select({ count: count() }).from(sources),
    database.select({ count: count() }).from(memories),
    database.select({ count: count() }).from(users).where(gte(users.createdAt, since)),
    database.select({ count: count() }).from(organizations).where(gte(organizations.createdAt, since)),
  ]);
  return c.json({ days, totals: {
    users: userTotal[0]?.count ?? 0, organizations: orgTotal[0]?.count ?? 0,
    active_spaces: spaceTotal[0]?.count ?? 0, sources: sourceTotal[0]?.count ?? 0,
    memories: memoryTotal[0]?.count ?? 0,
  }, new: { users: newUsers[0]?.count ?? 0, organizations: newOrgs[0]?.count ?? 0 } });
});

app.get('/admin/ingestion-health', async (c) => {
  const database = db(c);
  const limit = positiveInt(c.req.query('limit'), 50, 100);
  const stuckBefore = new Date(Date.now() - 15 * 60_000);
  const [failed, stuck, tombstones, pendingDeletions] = await Promise.all([
    database.select({ id: ingestionJobs.id, status: ingestionJobs.status, completed_at: ingestionJobs.completedAt })
      .from(ingestionJobs).where(eq(ingestionJobs.status, 'failed')).orderBy(desc(ingestionJobs.completedAt)).limit(limit),
    database.select({ id: ingestionJobs.id, status: ingestionJobs.status, started_at: ingestionJobs.startedAt })
      .from(ingestionJobs).where(and(eq(ingestionJobs.status, 'processing'), lt(ingestionJobs.startedAt, stuckBefore)))
      .orderBy(ingestionJobs.startedAt).limit(limit),
    database.select({ count: count() }).from(memorySpaces).where(isNotNull(memorySpaces.deletedAt)),
    database.select({
      space_id: memorySpaces.uuid,
      org_id: memorySpaces.orgId,
      name: memorySpaces.name,
      deleted_at: memorySpaces.deletedAt,
    }).from(memorySpaces).where(isNotNull(memorySpaces.deletedAt))
      .orderBy(memorySpaces.deletedAt).limit(limit),
  ]);
  return c.json({
    failed,
    stuck,
    tombstoned_spaces: tombstones[0]?.count ?? 0,
    pending_deletions: pendingDeletions.map((space) => ({
      ...space,
      purge_eligible_at: new Date(space.deleted_at!.getTime() + 30 * 24 * 60 * 60_000),
    })),
    limit,
  });
});

app.get('/admin/users', async (c) => {
  const email = c.req.query('email')?.trim().toLowerCase();
  if (!email) return c.json({ detail: 'email is required' }, 400);
  const rows = await db(c).select({ id: users.uuid, email: users.email, name: users.name, active: users.isActive })
    .from(users).where(eq(sql`lower(${users.email})`, email)).limit(1);
  return c.json({ users: rows });
});

app.get('/admin/audit', async (c) => {
  const database = db(c);
  const limit = positiveInt(c.req.query('limit'), 50, 100);
  const before = Number(c.req.query('before') ?? Number.MAX_SAFE_INTEGER);
  const rows = await database.select().from(adminAuditLog)
    .where(lt(adminAuditLog.id, Number.isSafeInteger(before) ? before : Number.MAX_SAFE_INTEGER))
    .orderBy(desc(adminAuditLog.id)).limit(limit);
  await database.insert(adminAuditLog).values({
    actorEmail: c.var.actorEmail, action: 'audit.read', targetType: 'audit_log',
    targetId: String(before), before: null, after: { returned: rows.length }, requestId: c.var.requestId,
  });
  return c.json({ items: rows, next_before: rows.at(-1)?.id ?? null });
});

const grantBody = z.object({
  plan: z.enum(['free', 'developer', 'pro', 'enterprise']),
  expires_at: z.string().datetime(),
});
app.put('/admin/orgs/:uuid/grant', async (c) => {
  const parsed = grantBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ detail: 'Invalid grant' }, 400);
  const expiry = new Date(parsed.data.expires_at);
  if (expiry <= new Date()) return c.json({ detail: 'expires_at must be in the future' }, 400);
  const database = db(c);
  const result = await database.transaction(async (tx) => {
    const [before] = await tx.select().from(organizations)
      .where(eq(organizations.uuid, c.req.param('uuid'))).limit(1).for('update');
    if (!before) return null;
    const [after] = await tx.update(organizations).set({
      grantedPlan: parsed.data.plan,
      grantedPlanExpiresAt: expiry,
      updatedAt: new Date(),
    }).where(eq(organizations.id, before.id)).returning();
    await tx.insert(adminAuditLog).values({
      actorEmail: c.var.actorEmail, action: 'plan_grant.upsert', targetType: 'organization',
      targetId: before.uuid, before: { granted_plan: before.grantedPlan, expires_at: before.grantedPlanExpiresAt },
      after: { granted_plan: after!.grantedPlan, expires_at: after!.grantedPlanExpiresAt },
      requestId: c.var.requestId,
    });
    return after;
  });
  if (!result) return c.json({ detail: 'Organization not found' }, 404);
  await invalidateEntitlementCache(c.env.API_KEY_CACHE, result.id);
  return c.json({ organization_id: result.uuid, granted_plan: result.grantedPlan, expires_at: result.grantedPlanExpiresAt });
});

app.delete('/admin/orgs/:uuid/grant', async (c) => {
  const database = db(c);
  const result = await database.transaction(async (tx) => {
    const [before] = await tx.select().from(organizations)
      .where(eq(organizations.uuid, c.req.param('uuid'))).limit(1).for('update');
    if (!before) return null;
    const [after] = await tx.update(organizations).set({
      grantedPlan: null, grantedPlanExpiresAt: null, updatedAt: new Date(),
    }).where(eq(organizations.id, before.id)).returning();
    await tx.insert(adminAuditLog).values({
      actorEmail: c.var.actorEmail, action: 'plan_grant.revoke', targetType: 'organization',
      targetId: before.uuid, before: { granted_plan: before.grantedPlan, expires_at: before.grantedPlanExpiresAt },
      after: { granted_plan: null, expires_at: null }, requestId: c.var.requestId,
    });
    return after;
  });
  if (!result) return c.json({ detail: 'Organization not found' }, 404);
  await invalidateEntitlementCache(c.env.API_KEY_CACHE, result.id);
  return c.json({ organization_id: result.uuid, granted_plan: null });
});

app.post('/admin/api-keys/:uuid/invalidate-cache', async (c) => {
  const database = db(c);
  const [key] = await database.select({ uuid: apiKeys.uuid, keyHash: apiKeys.keyHash })
    .from(apiKeys).where(eq(apiKeys.uuid, c.req.param('uuid'))).limit(1);
  if (!key) return c.json({ detail: 'API key not found' }, 404);
  await invalidateApiKeyCacheHash(c.env.API_KEY_CACHE, key.keyHash);
  await database.insert(adminAuditLog).values({
    actorEmail: c.var.actorEmail,
    action: 'api_key.cache_invalidated',
    targetType: 'api_key',
    targetId: key.uuid,
    before: null,
    after: { invalidated: true },
    requestId: c.var.requestId,
  });
  return c.json({ api_key_id: key.uuid, invalidated: true });
});

app.post('/admin/sources/:uuid/requeue', async (c) => {
  const database = db(c);
  const result = await database.transaction(async (tx) => {
    const [source] = await tx.select().from(sources)
      .where(eq(sources.uuid, c.req.param('uuid'))).limit(1).for('update');
    if (!source) return { status: 'not_found' as const };
    if (source.extractionStatus === 'completed') return { status: 'completed' as const };
    const attempts = Number((source.meta as Record<string, unknown> | null)?.redrive_attempts ?? 0);
    if (attempts >= 5) return { status: 'exhausted' as const };
    const [activeJob] = await tx.select({ id: ingestionJobs.id }).from(ingestionJobs)
      .where(and(
        sql`${ingestionJobs.status} IN ('pending', 'processing')`,
        sql`${ingestionJobs.sourceIds} @> ${JSON.stringify([source.id])}::jsonb`,
      )).limit(1);
    if (activeJob) {
      await tx.insert(adminAuditLog).values({
        actorEmail: c.var.actorEmail,
        action: 'source.requeue_noop',
        targetType: 'source',
        targetId: source.uuid,
        before: { extraction_status: source.extractionStatus, active_job_id: activeJob.id },
        after: { extraction_status: source.extractionStatus, active_job_id: activeJob.id },
        requestId: c.var.requestId,
      });
      return { status: 'queued' as const, activeJobId: activeJob.id };
    }
    const eligibleAt = new Date(Date.now() - 3 * 60_000);
    await tx.update(sources).set({
      extractionStatus: 'failed',
      updatedAt: eligibleAt,
      meta: sql`coalesce(${sources.meta}, '{}'::jsonb) || ${JSON.stringify({ admin_redrive_requested: true })}::jsonb`,
    }).where(eq(sources.id, source.id));
    await tx.insert(adminAuditLog).values({
      actorEmail: c.var.actorEmail,
      action: 'source.requeue_requested',
      targetType: 'source',
      targetId: source.uuid,
      before: { extraction_status: source.extractionStatus, redrive_attempts: attempts },
      after: { extraction_status: 'failed', redrive_attempts: attempts },
      requestId: c.var.requestId,
    });
    return { status: 'queued' as const, activeJobId: null };
  });
  if (result.status === 'not_found') return c.json({ detail: 'Source not found' }, 404);
  if (result.status === 'completed') return c.json({ detail: 'Completed sources cannot be requeued' }, 409);
  if (result.status === 'exhausted') return c.json({ detail: 'Source redrive budget is exhausted' }, 409);
  return c.json({ source_id: c.req.param('uuid'), requeue_requested: true, active_job_id: result.activeJobId });
});

app.post('/admin/spaces/:uuid/restore', async (c) => {
  const database = db(c);
  const now = new Date();
  const retentionCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60_000);
  const result = await database.transaction(async (tx) => {
    const [before] = await tx.select().from(memorySpaces)
      .where(eq(memorySpaces.uuid, c.req.param('uuid'))).limit(1).for('update');
    if (!before) return { status: 'not_found' as const };
    if (before.deletedAt === null) {
      await tx.insert(adminAuditLog).values({
        actorEmail: c.var.actorEmail,
        action: 'space.restore_noop',
        targetType: 'memory_space',
        targetId: before.uuid,
        before: { deleted_at: null },
        after: { deleted_at: null },
        requestId: c.var.requestId,
      });
      return { status: 'restored' as const, space: before };
    }
    if (before.deletedAt <= retentionCutoff) return { status: 'expired' as const };
    const [nameConflict] = await tx.select({ id: memorySpaces.id }).from(memorySpaces)
      .where(and(
        eq(memorySpaces.orgId, before.orgId),
        eq(memorySpaces.name, before.name),
        sql`${memorySpaces.deletedAt} IS NULL`,
        sql`${memorySpaces.id} <> ${before.id}`,
      )).limit(1);
    if (nameConflict) return { status: 'name_conflict' as const };
    const [after] = await tx.update(memorySpaces).set({ deletedAt: null, updatedAt: now })
      .where(eq(memorySpaces.id, before.id)).returning();
    await tx.insert(adminAuditLog).values({
      actorEmail: c.var.actorEmail,
      action: 'space.restore',
      targetType: 'memory_space',
      targetId: before.uuid,
      before: { deleted_at: before.deletedAt },
      after: { deleted_at: null },
      requestId: c.var.requestId,
    });
    return { status: 'restored' as const, space: after! };
  });
  if (result.status === 'not_found') return c.json({ detail: 'Space not found' }, 404);
  if (result.status === 'expired') return c.json({ detail: 'Restore window expired' }, 409);
  if (result.status === 'name_conflict') return c.json({ detail: 'An active space now uses this name' }, 409);
  return c.json({ space_id: result.space.uuid, restored: true });
});

app.onError((error, c) => {
  createLogger({ service: 'admin', environment: c.env.ENVIRONMENT, base: { request_id: c.var.requestId } })
    .error('admin.unhandled_error', {}, error);
  return c.json({ detail: 'Internal server error', request_id: c.var.requestId }, 500);
});

export default app;
