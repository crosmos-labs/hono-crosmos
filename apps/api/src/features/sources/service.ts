import {
  memorySpaces,
  sources,
  type Source,
} from '@crosmos/db';
import type { Database } from '@crosmos/db';
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { scopeSources, type TenantScope } from '../../lib/scope';

export type ContentType =
  | 'text'
  | 'markdown'
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
  sequence?: number;
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
      content: input.content,
      contentType: input.contentType ?? 'text',
      sequence: input.sequence ?? 0,
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
        content: input.content,
        contentType: input.contentType ?? 'text',
        sequence: input.sequence ?? 0,
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

/**
 * Unscoped lookup. Trusted callers only (the ingestion worker, which has
 * already been handed an `(orgId, spaceId)` via the queue payload set by
 * the authenticated producer). API routes must use `getSourceByUuid`.
 *
 * Mirrors Python's `get_source_by_id` — see tenancy.md.
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

  const rows = await db
    .select({ c: count() })
    .from(sources)
    .where(and(...conditions));
  return rows[0]?.c ?? 0;
}

export async function deleteSource(
  db: Database,
  scope: TenantScope,
  sourceId: number,
): Promise<boolean> {
  const rows = await db
    .delete(sources)
    .where(and(scopeSources(scope), eq(sources.id, sourceId)))
    .returning({ id: sources.id });
  return rows.length > 0;
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
