import {
  chunkMemories,
  chunks,
  edges,
  memories,
  memorySpaces,
  sources,
  type Source,
} from '@crosmos/db';
import type { Database } from '@crosmos/db';
import { and, count, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { scopeSources, type TenantScope } from '../../lib/scope';

export type ContentType =
  | 'text'
  | 'markdown'
  | 'conversation'
  | 'html'
  | 'json'
  | 'pdf'
  | 'image'
  | 'audio'
  | 'video';

export type ExtractionStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface CreateSourceInput {
  scope: TenantScope;
  content: string;
  contentType?: ContentType;
  visibility?: 'private' | 'org';
  meta?: Record<string, unknown> | null;
  tokenCount?: number;
}

/**
 * Insert one source. Does NOT commit — Drizzle on `postgres-js` autocommits
 * each query, so unlike the Python version, callers don't manage a session.
 * Batching multiple inserts into one transaction is the caller's job (see
 * `createSources`).
 */
export async function createSource(
  db: Database,
  input: CreateSourceInput,
): Promise<Source> {
  const [row] = await db
    .insert(sources)
    .values({
      orgId: input.scope.orgId,
      spaceId: input.scope.spaceId,
      ownerUserId: input.scope.userId,
      visibility: input.visibility ?? 'private',
      content: input.content,
      contentType: input.contentType ?? 'text',
      meta: input.meta ?? null,
      tokenCount: input.tokenCount ?? 0,
    })
    .returning();
  if (!row) throw new Error('Failed to insert source');
  return row;
}

/**
 * Insert N sources in one round-trip. Order in the returned array matches
 * order in `inputs`. Used by both POST /sources and POST /conversations.
 */
export async function createSources(
  db: Database,
  inputs: CreateSourceInput[],
): Promise<Source[]> {
  if (inputs.length === 0) return [];
  return db
    .insert(sources)
    .values(
      inputs.map((input) => ({
        orgId: input.scope.orgId,
        spaceId: input.scope.spaceId,
        ownerUserId: input.scope.userId,
        visibility: input.visibility ?? 'private',
        content: input.content,
        contentType: input.contentType ?? 'text',
        meta: input.meta ?? null,
        tokenCount: input.tokenCount ?? 0,
      })),
    )
    .returning();
}

export async function getSourceByUuid(
  db: Database,
  scope: TenantScope,
  sourceUuid: string,
): Promise<Source | null> {
  const rows = await db
    .select()
    .from(sources)
    .where(and(scopeSources(scope), eq(sources.uuid, sourceUuid)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getSourceForCaller(
  db: Database,
  input: {
    sourceUuid: string;
    orgId: number;
    spaceId?: number;
    visibleUserIds: readonly number[] | null;
  },
): Promise<Source | null> {
  const conditions = [
    eq(sources.uuid, input.sourceUuid),
    eq(sources.orgId, input.orgId),
  ];
  if (input.spaceId !== undefined) conditions.push(eq(sources.spaceId, input.spaceId));
  if (input.visibleUserIds != null) {
    conditions.push(
      input.visibleUserIds.length === 0
        ? sql`false`
        : or(
            eq(sources.visibility, 'org'),
            inArray(sources.ownerUserId, [...input.visibleUserIds]),
          )!,
    );
  }
  const [source] = await db.select().from(sources).where(and(...conditions)).limit(1);
  return source ?? null;
}

export async function getSpaceIdentityByUuid(db: Database, uuid: string) {
  const [space] = await db
    .select({ id: memorySpaces.id, orgId: memorySpaces.orgId })
    .from(memorySpaces)
    .where(eq(memorySpaces.uuid, uuid))
    .limit(1);
  return space ?? null;
}

export async function getSpaceUuidById(db: Database, id: number): Promise<string | null> {
  const [space] = await db
    .select({ uuid: memorySpaces.uuid })
    .from(memorySpaces)
    .where(eq(memorySpaces.id, id))
    .limit(1);
  return space?.uuid ?? null;
}

export async function deleteSourcesByIds(
  db: Database,
  input: { orgId: number; spaceId: number; sourceIds: number[] },
): Promise<void> {
  if (input.sourceIds.length === 0) return;
  await db.delete(sources).where(and(
    eq(sources.orgId, input.orgId),
    eq(sources.spaceId, input.spaceId),
    inArray(sources.id, input.sourceIds),
  ));
}

/**
 * Unscoped lookup. Trusted callers only (the ingestion worker, which has
 * already been handed an `(orgId, spaceId)` via the queue payload set by
 * the authenticated producer). API routes must use `getSourceByUuid`.
 *
 * Reads a source through the tenant scope supplied by the authenticated caller.
 */
export async function getSourceByIdUnscoped(
  db: Database,
  sourceId: number,
): Promise<Source | null> {
  const rows = await db
    .select()
    .from(sources)
    .where(eq(sources.id, sourceId))
    .limit(1);
  return rows[0] ?? null;
}

export interface ListSourcesFilters {
  orgId: number;
  spaceId?: number;
  contentType?: string;
  extractionStatus?: ExtractionStatus;
  visibleUserIds?: readonly number[] | null;
  limit?: number;
  offset?: number;
}

export interface SourceWithSpaceUuid {
  source: Source;
  spaceUuid: string;
}

/**
 * Org-wide source list (optionally scoped to a single space). Joined with
 * memory_spaces so the response can render the owning space UUID without an
 * extra round-trip — mirrors Python's `list_sources_by_org`.
 */
export async function listSourcesByOrg(
  db: Database,
  filters: ListSourcesFilters,
): Promise<SourceWithSpaceUuid[]> {
  const limit = filters.limit ?? 100;
  const offset = filters.offset ?? 0;

  const conditions = [eq(sources.orgId, filters.orgId)];
  if (filters.spaceId !== undefined)
    conditions.push(eq(sources.spaceId, filters.spaceId));
  if (filters.contentType !== undefined)
    conditions.push(eq(sources.contentType, filters.contentType));
  if (filters.extractionStatus !== undefined)
    conditions.push(eq(sources.extractionStatus, filters.extractionStatus));
  if (filters.visibleUserIds != null) {
    conditions.push(
      filters.visibleUserIds.length === 0
        ? sql`false`
        : or(
            eq(sources.visibility, 'org'),
            inArray(sources.ownerUserId, [...filters.visibleUserIds]),
          )!,
    );
  }

  const rows = await db
    .select({ source: sources, spaceUuid: memorySpaces.uuid })
    .from(sources)
    .innerJoin(memorySpaces, eq(memorySpaces.id, sources.spaceId))
    .where(and(...conditions))
    .orderBy(desc(sources.createdAt))
    .limit(limit)
    .offset(offset);

  return rows.map((r) => ({ source: r.source, spaceUuid: r.spaceUuid }));
}

export async function countSourcesByOrg(
  db: Database,
  filters: Omit<ListSourcesFilters, 'limit' | 'offset'>,
): Promise<number> {
  const conditions = [eq(sources.orgId, filters.orgId)];
  if (filters.spaceId !== undefined)
    conditions.push(eq(sources.spaceId, filters.spaceId));
  if (filters.contentType !== undefined)
    conditions.push(eq(sources.contentType, filters.contentType));
  if (filters.extractionStatus !== undefined)
    conditions.push(eq(sources.extractionStatus, filters.extractionStatus));
  if (filters.visibleUserIds != null) {
    conditions.push(
      filters.visibleUserIds.length === 0
        ? sql`false`
        : or(
            eq(sources.visibility, 'org'),
            inArray(sources.ownerUserId, [...filters.visibleUserIds]),
          )!,
    );
  }

  const rows = await db
    .select({ c: count() })
    .from(sources)
    .where(and(...conditions));
  return rows[0]?.c ?? 0;
}

export interface DeleteSourceResult {
  deleted: boolean;
  /**
   * Integer ids of the memories removed by this delete. Their vectors must be
   * purged from the external vector store (Vectorize) by the caller — the DB
   * delete can't reach into the index. Entities are intentionally excluded:
   * they are shared/deduplicated per space (resolved idempotently by name), so a
   * single source delete does not remove them (mirrors the ingestion pipeline's
   * `purgeSourceArtifacts`, which only deletes memory vectors).
   */
  memoryIds: number[];
}

/**
 * Delete a source AND the memories it produced.
 *
 * IMPORTANT: `memories` has no FK to `sources`/`chunks`, so deleting the source
 * row only cascades `sources → chunks → chunk_memories` — it would leave the
 * memory rows (and their vectors) orphaned. Orphaned memory rows with no vector
 * are worse than a pure storage leak: retrieval still loads them as candidates
 * but they have no embedding. So we replicate the ingestion pipeline's
 * `purgeSourceArtifacts` cleanup order: delete edges referencing those memories
 * (edges.memory_id is ON DELETE SET NULL, so they'd otherwise be orphaned, not
 * removed), delete the memories, then delete the source (its cascade clears the
 * chunks + junction rows). The returned `memoryIds` are then purged from the
 * external vector store by the caller.
 */
export async function deleteSource(
  db: Database,
  scope: TenantScope,
  sourceId: number,
): Promise<DeleteSourceResult> {
  // Resolve the source's memories via chunks → chunk_memories, scoped via
  // `scopeSources` so a cross-tenant id can't enumerate/delete foreign rows.
  const chunkRows = await db
    .select({ id: chunks.id })
    .from(chunks)
    .innerJoin(sources, eq(sources.id, chunks.sourceId))
    .where(and(scopeSources(scope), eq(sources.id, sourceId)));
  const chunkIds = chunkRows.map((r) => r.id);

  let memoryIds: number[] = [];
  if (chunkIds.length > 0) {
    const memRows = await db
      .select({ memoryId: chunkMemories.memoryId })
      .from(chunkMemories)
      .where(inArray(chunkMemories.chunkId, chunkIds));
    memoryIds = [...new Set(memRows.map((r) => r.memoryId))];
  }

  if (memoryIds.length > 0) {
    // edges.memory_id is ON DELETE SET NULL — delete them explicitly (matches
    // the pipeline) so deleting memories doesn't leave dangling edges.
    await db.delete(edges).where(inArray(edges.memoryId, memoryIds));
    // Scope the memory delete defensively to the source's org+space.
    await db
      .delete(memories)
      .where(
        and(
          eq(memories.orgId, scope.orgId),
          eq(memories.spaceId, scope.spaceId),
          inArray(memories.id, memoryIds),
        ),
      );
  }

  const rows = await db
    .delete(sources)
    .where(and(scopeSources(scope), eq(sources.id, sourceId)))
    .returning({ id: sources.id });
  const deleted = rows.length > 0;
  // If nothing was deleted (404/cross-tenant), don't report ids to purge.
  return { deleted, memoryIds: deleted ? memoryIds : [] };
}

export async function setSourceVisibility(
  db: Database,
  scope: TenantScope,
  sourceId: number,
  visibility: 'private' | 'org',
): Promise<{ memoriesUpdated: number; edgesUpdated: number }> {
  await db
    .update(sources)
    .set({ visibility, updatedAt: new Date() })
    .where(and(eq(sources.id, sourceId), eq(sources.orgId, scope.orgId)));

  const chunkRows = await db
    .select({ id: chunks.id })
    .from(chunks)
    .where(and(eq(chunks.sourceId, sourceId), eq(chunks.orgId, scope.orgId)));
  const chunkIds = chunkRows.map((r) => r.id);
  if (chunkIds.length === 0) return { memoriesUpdated: 0, edgesUpdated: 0 };

  const memoryRows = await db
    .select({ id: chunkMemories.memoryId })
    .from(chunkMemories)
    .where(inArray(chunkMemories.chunkId, chunkIds));
  const memoryIds = [...new Set(memoryRows.map((r) => r.id))];
  if (memoryIds.length === 0) return { memoriesUpdated: 0, edgesUpdated: 0 };

  const updatedMemories = await db
    .update(memories)
    .set({ visibility, updatedAt: new Date() })
    .where(and(eq(memories.orgId, scope.orgId), inArray(memories.id, memoryIds)))
    .returning({ id: memories.id });

  const updatedEdges = await db
    .update(edges)
    .set({ visibility })
    .where(and(eq(edges.orgId, scope.orgId), inArray(edges.memoryId, memoryIds)))
    .returning({ id: edges.id });

  return {
    memoriesUpdated: updatedMemories.length,
    edgesUpdated: updatedEdges.length,
  };
}

/**
 * Worker-side status transitions. Match Python's `mark_*` helpers — they
 * are scoped so a stray message can't update a source outside its claimed
 * org/space, and they don't commit (the caller controls transactions).
 */
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

/**
 * Failure variant: stores the error in `meta.error_message` via jsonb merge
 * so the meta blob isn't clobbered. Mirrors Python's `mark_failed`.
 */
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
