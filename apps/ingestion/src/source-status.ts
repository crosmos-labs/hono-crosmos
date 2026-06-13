/**
 * Source status helpers used by the queue consumer. Mirror Python's `mark_*`
 * variants — all scoped on (org_id, space_id) so a stray queue message
 * cannot mutate a source outside its claimed scope (defense-in-depth on top
 * of the producer-side authorization).
 *
 * The API worker has its own copies in `apps/api/src/features/sources/service.ts`.
 * Duplicating the ~30 lines is intentional: it avoids forcing cross-app
 * imports while the surface is small. Promote to `packages/db/` if drift
 * becomes a problem.
 */
import { sources, type Database } from '@crosmos/db';
import type { TenantScope } from '@crosmos/types';
import { and, eq, inArray, sql } from 'drizzle-orm';

export type ExtractionStatus = 'pending' | 'processing' | 'completed' | 'failed';

function scopeSources(scope: TenantScope) {
  return and(eq(sources.orgId, scope.orgId), eq(sources.spaceId, scope.spaceId))!;
}

export async function getSourceExtractionStatus(
  db: Database,
  sourceId: number,
): Promise<ExtractionStatus | null> {
  const rows = await db
    .select({ status: sources.extractionStatus })
    .from(sources)
    .where(eq(sources.id, sourceId))
    .limit(1);
  return rows[0]?.status ?? null;
}

export async function markSourcesStatus(
  db: Database,
  scope: TenantScope,
  sourceIds: number[],
  status: ExtractionStatus,
): Promise<void> {
  if (sourceIds.length === 0) return;
  await db
    .update(sources)
    .set({ extractionStatus: status, updatedAt: new Date() })
    .where(and(scopeSources(scope), inArray(sources.id, sourceIds)));
}

export async function markSourcesFailed(
  db: Database,
  scope: TenantScope,
  sourceIds: number[],
  errorMessage?: string,
): Promise<void> {
  if (sourceIds.length === 0) return;
  const values: Record<string, unknown> = {
    extractionStatus: 'failed',
    updatedAt: new Date(),
  };
  if (errorMessage !== undefined) {
    values.meta = sql`coalesce(${sources.meta}, '{}'::jsonb) || ${JSON.stringify({ error_message: errorMessage })}::jsonb`;
  }
  await db
    .update(sources)
    .set(values)
    .where(and(scopeSources(scope), inArray(sources.id, sourceIds)));
}

/**
 * Drive sources to a terminal `failed` state ONLY if they're still non-terminal
 * (`pending` or `processing`). Used when a job is cancelled mid-run to settle
 * its un-processed sources without clobbering ones a prior run already finished
 * (`completed`/`failed`). There's no `cancelled` value in the extraction-status
 * enum, so `failed` + a reason in `meta` is the closest terminal state.
 */
export async function markUnprocessedSourcesCancelled(
  db: Database,
  scope: TenantScope,
  sourceIds: number[],
  reason: string,
): Promise<void> {
  if (sourceIds.length === 0) return;
  await db
    .update(sources)
    .set({
      extractionStatus: 'failed',
      updatedAt: new Date(),
      meta: sql`coalesce(${sources.meta}, '{}'::jsonb) || ${JSON.stringify({ error_message: reason, cancelled: true })}::jsonb`,
    })
    .where(
      and(
        scopeSources(scope),
        inArray(sources.id, sourceIds),
        inArray(sources.extractionStatus, ['pending', 'processing']),
      ),
    );
}
