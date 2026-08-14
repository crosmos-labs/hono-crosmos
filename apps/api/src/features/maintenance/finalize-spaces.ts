/**
 * Physical cleanup of tombstoned memory spaces (P1-A).
 *
 * `DELETE /spaces/{uuid}` only sets `deleted_at`; from that instant the space is
 * absent to every normal read and no new work can enter it. This sweep does the
 * destructive half later, when it is actually safe:
 *
 *  - after a grace period longer than one ingestion lease, so a worker that
 *    claimed a job before the tombstone has had time to notice and stop; and
 *  - only while no non-terminal ingestion job still references the space, so the
 *    cascade cannot pull rows out from under a live writer.
 *
 * Order within a space is load-bearing: vectors are purged BEFORE the parent
 * row. The Postgres cascade is what makes the memory/entity ids unreachable, so
 * deleting the row first would strand those vectors in Qdrant permanently with
 * no way to enumerate them. If the vector purge fails, the tombstone is left in
 * place and the next sweep retries — idempotently, because the ids are still
 * derivable.
 *
 * That ordering is enforced by `deleteSpace`, which takes the purge as a
 * callback and runs it between collecting the ids and deleting the row. It is
 * deliberately not this file's job to sequence: this sweep read correct-looking
 * like the comment above for a full release while actually deleting the row
 * first, because the two steps were separate calls here and nothing failed when
 * they were swapped.
 *
 * Disabled by default. `SPACE_FINALIZER_ENABLED=true` turns it on, so the
 * tombstone/read-filtering half can be deployed and observed before anything
 * destructive runs.
 */
import { createLogger, createMetrics, durationMs } from '@crosmos/observability';
import type { Env } from '../../bindings';
import { createDb } from '@crosmos/db';
import { getVectorStore } from '../../integrations/vector-store';
import {
  countActiveJobsForSpace,
  deleteSpace,
  listSpacesPendingDeletion,
} from '../spaces/service';

/**
 * Product retention window for a deleted space. Thirty days gives customers
 * an audited recovery period while bounding erasure/storage retention. It also
 * comfortably exceeds the ingestion job lease (`JOB_LEASE_MS`, 5 min).
 * `SPACE_FINALIZER_ENABLED` remains the independent destructive kill switch.
 */
export const SPACE_FINALIZE_GRACE_MS = 30 * 24 * 60 * 60_000;

/** Spaces finalized per sweep. Bounded so one run cannot become unbounded work. */
export const SPACE_FINALIZE_BATCH = 10;

/** Max vector ids per delete call, bounding the upstream request size. */
const VECTOR_DELETE_CHUNK = 500;

export interface FinalizeSpacesResult {
  /** Tombstones past the grace period that this sweep considered. */
  candidates: number;
  /** Spaces physically deleted. */
  finalized: number;
  /** Skipped because ingestion jobs were still active. */
  skippedActiveJobs: number;
  /** Left tombstoned because the vector purge failed; retried next sweep. */
  failedVectorPurge: number;
  /** True when the finalizer is switched off. */
  disabled: boolean;
}

async function deleteVectorsChunked(
  vectorStore: ReturnType<typeof getVectorStore>,
  collection: 'memories' | 'entities',
  ids: number[],
): Promise<void> {
  for (let i = 0; i < ids.length; i += VECTOR_DELETE_CHUNK) {
    await vectorStore.deleteByIds(collection, ids.slice(i, i + VECTOR_DELETE_CHUNK));
  }
}

export async function runSpaceFinalization(env: Env): Promise<FinalizeSpacesResult> {
  const result: FinalizeSpacesResult = {
    candidates: 0,
    finalized: 0,
    skippedActiveJobs: 0,
    failedVectorPurge: 0,
    disabled: env.SPACE_FINALIZER_ENABLED !== 'true',
  };
  if (result.disabled) return result;

  const logger = createLogger({ service: 'api', environment: env.ENVIRONMENT });
  const metrics = createMetrics(env.ANALYTICS, {
    service: 'api',
    environment: env.ENVIRONMENT,
    version: env.CF_VERSION_METADATA?.id,
  });
  const db = createDb(env.HYPERDRIVE.connectionString, { max: 2 });
  const vectorStore = getVectorStore(env, db);

  const pending = await listSpacesPendingDeletion(db, {
    graceMs: SPACE_FINALIZE_GRACE_MS,
    limit: SPACE_FINALIZE_BATCH,
  });
  result.candidates = pending.length;

  for (const space of pending) {
    const started = performance.now();
    const spaceLogger = logger.child({ org_id: space.orgId, space_id: space.id });

    // A job created before the tombstone can still be draining. The grace
    // period usually covers this; the check is what makes it a guarantee.
    const activeJobs = await countActiveJobsForSpace(db, space.id);
    if (activeJobs > 0) {
      result.skippedActiveJobs++;
      spaceLogger.info('spaces.finalize_skipped', {
        reason: 'active_jobs',
        job_count: activeJobs,
      });
      continue;
    }

    try {
      // Collects memory + entity ids (keyset-paginated), purges their vectors,
      // and only then deletes the parent row, whose cascade removes everything
      // the space owns. `daily_usage` deliberately survives: its FK was dropped
      // so billing history outlives the space.
      const { deleted, memoryIds, entityIds } = await deleteSpace(db, {
        orgId: space.orgId,
        spaceId: space.id,
        purgeVectors: vectorStore.persistsInColumn
          ? undefined // cascade already removed them from the pg column
          : async ({ memoryIds: mIds, entityIds: eIds }) => {
              await deleteVectorsChunked(vectorStore, 'memories', mIds);
              await deleteVectorsChunked(vectorStore, 'entities', eIds);
            },
      });
      if (!deleted) {
        // Raced another finalizer run. Not an error.
        spaceLogger.info('spaces.finalize_skipped', { reason: 'already_gone' });
        continue;
      }

      result.finalized++;
      const ageMs = Date.now() - space.deletedAt.getTime();
      spaceLogger.info('spaces.finalized', {
        duration_ms: durationMs(started),
        memory_count: memoryIds.length,
        entity_count: entityIds.length,
        vector_count: memoryIds.length + entityIds.length,
        // How long the tombstone waited — the deletion-backlog signal.
        total_ms: ageMs,
      });
      metrics.count('space_finalized', {
        tags: [env.ENVIRONMENT],
        values: [durationMs(started), memoryIds.length + entityIds.length, ageMs],
        index: 'space_finalized',
      });
    } catch (err) {
      // The tombstone survives, so the next sweep retries. This is exactly the
      // case immediate hard deletion could not recover from — and it only holds
      // because `deleteSpace` purges vectors before the row and propagates the
      // failure instead of pressing on.
      result.failedVectorPurge++;
      // Not asserting `dependency: 'vector'`: a collect or delete can fail here
      // too, and mislabelling every failure as the vector store sends whoever
      // reads this at Qdrant when the problem is Postgres.
      spaceLogger.error('spaces.finalize_failed', { error_category: 'internal' }, err);
      metrics.count('space_finalize_failed', {
        tags: [env.ENVIRONMENT],
        index: 'space_finalize_failed',
      });
    }
  }

  return result;
}
