/**
 * Candidate loading + write-side bookkeeping for retrieval. Sits at the
 * boundary between scoping (here) and the pure engine code (signals). Ports
 * `app/services/retrieval.py` (loader) + `services/memories.py:touch_memories`
 * + the `chunk_memories → chunks → sources` text attach.
 *
 * Loading model: there is NO whole-space working-set load. Each signal narrows
 * to a bounded id set first (ANN, GIN, BFS) and then hydrates only those ids by
 * id via `hydrateMemories` — so per-query cost is O(candidates), not O(space).
 * Every hydration goes through `scopeMemories`, which carries the full org +
 * space + per-user visibility rule, so by-id hydration is visibility-equivalent
 * to the old pre-loaded visible set (the previous correctness anchor).
 */
import { type Database, memories, entities, memoryEntities, chunkMemories, chunks, sources } from '@crosmos/db';
import type { TenantScope } from '@crosmos/types';
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { scopeEntities, scopeMemories, sourceVisibilityClause } from '../../lib/scope';
import type { RankedCandidate, RetrievalMemoryRow, RetrievalEntityRow } from './types';

/**
 * The exact column set ranking reads off a memory row (see `RetrievalMemoryRow`).
 * Shared by every signal that hydrates memory rows so the projection stays in
 * one place. Deliberately omits `embedding` (vector; null on the qdrant/vectorize
 * backends, fetched by id for MMR), `meta`, `visibility`, `updatedAt`, and the
 * clustering columns — none are read by the ranking pipeline or response mapper.
 */
export const retrievalMemoryColumns = {
  id: memories.id,
  uuid: memories.uuid,
  content: memories.content,
  memoryType: memories.memoryType,
  ownerUserId: memories.ownerUserId,
  orgId: memories.orgId,
  spaceId: memories.spaceId,
  importanceScore: memories.importanceScore,
  createdAt: memories.createdAt,
  recordedAt: memories.recordedAt,
  accessFrequency: memories.accessFrequency,
  lastAccessedAt: memories.lastAccessedAt,
  eventTime: memories.eventTime,
  forgottenAt: memories.forgottenAt,
} as const;

/**
 * Hydrate the given memory ids → row map, filtered to the caller's visible,
 * non-forgotten set. This is the visibility-enforcement point that replaces the
 * old pre-loaded working set: `scopeMemories` applies org + space + the per-user
 * `visibility='org' OR owner ∈ visibleUserIds` clause, so an id that is private
 * to another user (or forgotten) is simply absent from the result — exactly the
 * intersection the semantic/graph signals used to do against `memoryById`.
 */
export async function hydrateMemories(
  db: Database,
  scope: TenantScope,
  ids: number[],
): Promise<Map<number, RetrievalMemoryRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select(retrievalMemoryColumns)
    .from(memories)
    .where(and(scopeMemories(scope), isNull(memories.forgottenAt), inArray(memories.id, ids)));
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * In-scope entities whose name shares ≥1 of the given (already-tokenized) query
 * terms — the graph name-seed's candidate fetch, via the `entities_name_simple_gin_idx`
 * GIN index. Replaces scanning every in-scope entity: it returns exactly the
 * entities with non-zero token overlap (the only ones the seed keeps), so the
 * seed's exact overlap math + normalization are unchanged.
 *
 * `simple` config (no stemming/stopwords) makes the index match a faithful
 * superset of the JS tokenizer: every JS name-token is also a `simple` lexeme,
 * so any entity the old scan would have scored is returned here. Tokens are
 * OR-joined and run through `websearch_to_tsquery` (not `to_tsquery`) so they
 * can never raise a syntax error. Returns [] when there are no query tokens.
 */
export async function getEntitiesByNameTokens(
  db: Database,
  scope: TenantScope,
  tokens: string[],
): Promise<RetrievalEntityRow[]> {
  if (tokens.length === 0) return [];
  const tsquery = tokens.join(' or ');
  return db
    .select({ id: entities.id, name: entities.name })
    .from(entities)
    .where(
      and(
        scopeEntities(scope),
        sql`to_tsvector('simple', ${entities.name}) @@ websearch_to_tsquery('simple', ${tsquery})`,
      ),
    );
}

/**
 * `entity_id → [visible memory_id, ...]` for the given entity ids. The join
 * against `memories` under `scopeMemories` (+ not-forgotten) means only links to
 * memories the caller can see are returned — so relevance never propagates
 * through, nor is a seed memory ever drawn from, an invisible memory.
 */
export async function getMemoriesForEntities(
  db: Database,
  scope: TenantScope,
  entityIds: number[],
): Promise<Map<number, number[]>> {
  if (entityIds.length === 0) return new Map();
  const links = await db
    .select({ entityId: memoryEntities.entityId, memoryId: memoryEntities.memoryId })
    .from(memoryEntities)
    .innerJoin(memories, eq(memories.id, memoryEntities.memoryId))
    .where(
      and(
        scopeMemories(scope),
        isNull(memories.forgottenAt),
        inArray(memoryEntities.entityId, entityIds),
      ),
    )
    .orderBy(asc(memoryEntities.entityId), asc(memoryEntities.memoryId));
  const out = new Map<number, number[]>();
  for (const { entityId, memoryId } of links) {
    const list = out.get(entityId);
    if (list) list.push(memoryId);
    else out.set(entityId, [memoryId]);
  }
  return out;
}

/**
 * `memory_id → [entity_id, ...]` for the given (visible) memory ids — used to
 * propagate memory-seed similarity onto entities. The join enforces visibility,
 * so an ANN memory hit the caller can't see contributes no entities.
 */
export async function getEntitiesForMemories(
  db: Database,
  scope: TenantScope,
  memoryIds: number[],
): Promise<Map<number, number[]>> {
  if (memoryIds.length === 0) return new Map();
  const links = await db
    .select({ memoryId: memoryEntities.memoryId, entityId: memoryEntities.entityId })
    .from(memoryEntities)
    .innerJoin(memories, eq(memories.id, memoryEntities.memoryId))
    .where(
      and(
        scopeMemories(scope),
        isNull(memories.forgottenAt),
        inArray(memoryEntities.memoryId, memoryIds),
      ),
    )
    .orderBy(asc(memoryEntities.memoryId), asc(memoryEntities.entityId));
  const out = new Map<number, number[]>();
  for (const { memoryId, entityId } of links) {
    const list = out.get(memoryId);
    if (list) list.push(entityId);
    else out.set(memoryId, [entityId]);
  }
  return out;
}

/**
 * Of the given entity ids, the subset linked to ≥1 visible, non-forgotten
 * memory. Used (only when per-user visibility is active) to restrict the graph
 * seed-entity universe to entities reachable through memories the caller can
 * see — parity with the old in-memory `entities.filter(linked-to-visible)`.
 */
export async function getEntityIdsLinkedToVisibleMemories(
  db: Database,
  scope: TenantScope,
  entityIds: number[],
): Promise<Set<number>> {
  if (entityIds.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ entityId: memoryEntities.entityId })
    .from(memoryEntities)
    .innerJoin(memories, eq(memories.id, memoryEntities.memoryId))
    .where(
      and(
        scopeMemories(scope),
        isNull(memories.forgottenAt),
        inArray(memoryEntities.entityId, entityIds),
      ),
    );
  return new Set(rows.map((r) => r.entityId));
}

/**
 * Attach source text + source id to the top candidates. Resolves via
 * `chunk_memories → chunks → sources`, matching Python's citation path. One
 * source per memory (lowest source id, then chunk sequence) keeps the response
 * deterministic.
 *
 * **Scoping (defense in depth).** Pass the full `TenantScope` so the source join
 * is filtered by `(org_id, space_id)` AND the per-user `sourceVisibilityClause`
 * — not org alone. The candidate memory ids are already visibility-scoped, but a
 * memory can be cited by a source in another space or a private source the caller
 * can't read; scoping the source side prevents that text from leaking into the
 * `source` field. A bare `orgId: number` is still accepted (legacy callers) but
 * only applies org scoping — prefer passing the scope.
 */
export async function attachSourceText(
  db: Database,
  scopeOrOrgId: TenantScope | number,
  candidateLookup: Map<number, RankedCandidate>,
): Promise<void> {
  const ids = [...candidateLookup.keys()];
  if (ids.length === 0) return;

  // Build the source-side scope conditions from whichever form we were given.
  const sourceConditions: (SQL | undefined)[] = [];
  if (typeof scopeOrOrgId === 'number') {
    sourceConditions.push(eq(sources.orgId, scopeOrOrgId));
  } else {
    sourceConditions.push(
      eq(sources.orgId, scopeOrOrgId.orgId),
      eq(sources.spaceId, scopeOrOrgId.spaceId),
      sourceVisibilityClause(scopeOrOrgId),
    );
  }

  const rows = await db
    .select({
      memoryId: chunkMemories.memoryId,
      content: sources.content,
      sourceId: sources.id,
      sourceUuid: sources.uuid,
      sourceMeta: sources.meta,
    })
    .from(chunkMemories)
    .innerJoin(chunks, eq(chunks.id, chunkMemories.chunkId))
    .innerJoin(sources, eq(sources.id, chunks.sourceId))
    .where(and(...sourceConditions, inArray(chunkMemories.memoryId, ids)))
    .orderBy(asc(chunkMemories.memoryId), asc(sources.id), asc(chunks.sequence));

  const seen = new Set<number>();
  for (const row of rows) {
    if (seen.has(row.memoryId)) continue; // keep first (lowest source id)
    seen.add(row.memoryId);
    const candidate = candidateLookup.get(row.memoryId);
    if (candidate) {
      candidate.sourceChunk = row.content;
      candidate.sourceId = row.sourceId;
      candidate.sourceUuid = row.sourceUuid;
      // session_id lives in the source's meta (set by the conversations route);
      // surfaced so consumers/benchmarks can attribute a memory to its session.
      const meta = row.sourceMeta as Record<string, unknown> | null;
      candidate.sessionId = typeof meta?.session_id === 'string' ? meta.session_id : null;
    }
  }
}

/**
 * Bump `access_frequency += 1` and set `last_accessed_at = now` for the given
 * memories, scoped to org+space (call with `user_id = 0` — touch is not
 * user-attributed). Cross-tenant ids silently no-op. Returns rows touched.
 */
export async function touchMemories(
  db: Database,
  scope: TenantScope,
  memoryIds: number[],
): Promise<void> {
  if (memoryIds.length === 0) return;
  await db
    .update(memories)
    .set({
      lastAccessedAt: new Date(),
      accessFrequency: sql`${memories.accessFrequency} + 1`,
    })
    .where(and(scopeMemories(scope), inArray(memories.id, memoryIds)));
}
