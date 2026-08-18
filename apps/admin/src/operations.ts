import {
  adminAuditLog,
  ingestionJobs,
  memorySpaces,
  organizations,
  sources,
  type Database,
} from '@crosmos/db';
import { and, eq, sql } from 'drizzle-orm';

interface AuditActor {
  actorEmail: string;
  requestId: string;
}

export async function upsertPlanGrant(
  database: Database,
  input: AuditActor & {
    organizationUuid: string;
    plan: 'free' | 'developer' | 'pro' | 'enterprise';
    expiresAt: Date;
  },
) {
  return database.transaction(async (tx) => {
    const [before] = await tx.select().from(organizations)
      .where(eq(organizations.uuid, input.organizationUuid)).limit(1).for('update');
    if (!before) return null;
    const [after] = await tx.update(organizations).set({
      grantedPlan: input.plan,
      grantedPlanExpiresAt: input.expiresAt,
      updatedAt: new Date(),
    }).where(eq(organizations.id, before.id)).returning();
    await tx.insert(adminAuditLog).values({
      actorEmail: input.actorEmail,
      action: 'plan_grant.upsert',
      targetType: 'organization',
      targetId: before.uuid,
      before: { granted_plan: before.grantedPlan, expires_at: before.grantedPlanExpiresAt },
      after: { granted_plan: after!.grantedPlan, expires_at: after!.grantedPlanExpiresAt },
      requestId: input.requestId,
    });
    return after!;
  });
}

export async function revokePlanGrant(
  database: Database,
  input: AuditActor & { organizationUuid: string },
) {
  return database.transaction(async (tx) => {
    const [before] = await tx.select().from(organizations)
      .where(eq(organizations.uuid, input.organizationUuid)).limit(1).for('update');
    if (!before) return null;
    const [after] = await tx.update(organizations).set({
      grantedPlan: null,
      grantedPlanExpiresAt: null,
      updatedAt: new Date(),
    }).where(eq(organizations.id, before.id)).returning();
    await tx.insert(adminAuditLog).values({
      actorEmail: input.actorEmail,
      action: 'plan_grant.revoke',
      targetType: 'organization',
      targetId: before.uuid,
      before: { granted_plan: before.grantedPlan, expires_at: before.grantedPlanExpiresAt },
      after: { granted_plan: null, expires_at: null },
      requestId: input.requestId,
    });
    return after!;
  });
}

export async function requestSourceRequeue(
  database: Database,
  input: AuditActor & { sourceUuid: string },
) {
  return database.transaction(async (tx) => {
    const [source] = await tx.select().from(sources)
      .where(eq(sources.uuid, input.sourceUuid)).limit(1).for('update');
    if (!source) return { status: 'not_found' as const };
    if (source.extractionStatus === 'completed') return { status: 'completed' as const };
    const attempts = Number(
      (source.meta as Record<string, unknown> | null)?.redrive_attempts ?? 0,
    );
    if (attempts >= 5) return { status: 'exhausted' as const };
    const [activeJob] = await tx.select({ id: ingestionJobs.id }).from(ingestionJobs)
      .where(and(
        sql`${ingestionJobs.status} IN ('pending', 'processing')`,
        sql`${ingestionJobs.sourceIds} @> ${JSON.stringify([source.id])}::jsonb`,
      )).limit(1);
    if (activeJob) {
      await tx.insert(adminAuditLog).values({
        actorEmail: input.actorEmail,
        action: 'source.requeue_noop',
        targetType: 'source',
        targetId: source.uuid,
        before: { extraction_status: source.extractionStatus, active_job_id: activeJob.id },
        after: { extraction_status: source.extractionStatus, active_job_id: activeJob.id },
        requestId: input.requestId,
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
      actorEmail: input.actorEmail,
      action: 'source.requeue_requested',
      targetType: 'source',
      targetId: source.uuid,
      before: { extraction_status: source.extractionStatus, redrive_attempts: attempts },
      after: { extraction_status: 'failed', redrive_attempts: attempts },
      requestId: input.requestId,
    });
    return { status: 'queued' as const, activeJobId: null };
  });
}

export async function restoreSpace(
  database: Database,
  input: AuditActor & { spaceUuid: string; now: Date },
) {
  const retentionCutoff = new Date(input.now.getTime() - 30 * 24 * 60 * 60_000);
  return database.transaction(async (tx) => {
    const [before] = await tx.select().from(memorySpaces)
      .where(eq(memorySpaces.uuid, input.spaceUuid)).limit(1).for('update');
    if (!before) return { status: 'not_found' as const };
    if (before.deletedAt === null) {
      await tx.insert(adminAuditLog).values({
        actorEmail: input.actorEmail,
        action: 'space.restore_noop',
        targetType: 'memory_space',
        targetId: before.uuid,
        before: { deleted_at: null },
        after: { deleted_at: null },
        requestId: input.requestId,
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
    const [after] = await tx.update(memorySpaces)
      .set({ deletedAt: null, updatedAt: input.now })
      .where(eq(memorySpaces.id, before.id)).returning();
    await tx.insert(adminAuditLog).values({
      actorEmail: input.actorEmail,
      action: 'space.restore',
      targetType: 'memory_space',
      targetId: before.uuid,
      before: { deleted_at: before.deletedAt },
      after: { deleted_at: null },
      requestId: input.requestId,
    });
    return { status: 'restored' as const, space: after! };
  });
}
