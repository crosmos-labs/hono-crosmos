/**
 * Candidate loading + write-side bookkeeping for retrieval. Sits at the
 * boundary between scoping (here) and the pure engine code (signals). Ports
 * `app/services/retrieval.py` (loader) + `services/memories.py:touch_memories`
 * + the `chunk_memories → chunks → sources` text attach.
 */
import { type Database, type Memory, type Entity, memories, entities, memoryEntities, chunkMemories, chunks, sources } from '@crosmos/db';
import type { TenantScope } from '@crosmos/types';
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { scopeEntities, scopeMemories, sourceVisibilityClause } from '../../lib/scope';
import type { RankedCandidate } from './types';

export interface RetrievalCandidates {
  memories: Memory[];
  entities: Entity[];
  /** Empty on the store path (`include_edges = graph_store is None`). */
  edges: never[];
  memoryToEntities: Map<number, number[]>;
}

/** Load all non-forgotten memories in scope. */
export async function getRetrievalMemories(
  db: Database,
  scope: TenantScope,
): Promise<Memory[]> {
  return db
    .select()
    .from(memories)
    .where(and(scopeMemories(scope), isNull(memories.forgottenAt)));
}

/** Load all entities in scope. */
export async function getRetrievalEntities(
  db: Database,
  scope: TenantScope,
): Promise<Entity[]> {
  return db.select().from(entities).where(scopeEntities(scope));
}

/**
 * Build `memory_id → [entity_id, ...]` for the scope. Double-scoped: only
 * links where BOTH endpoints are in scope are kept (the junction carries no
 * org/space of its own). Mirrors `get_memory_to_entities_map`.
 */
export async function getMemoryToEntitiesMap(
  db: Database,
  scope: TenantScope,
): Promise<Map<number, number[]>> {
  // Single join replaces the old 3 sequential queries (memory ids → entity ids
  // → links). The joins enforce the same "both endpoints in scope" rule: a link
  // survives iff its memory is in-scope-and-not-forgotten AND its entity is
  // in-scope. Identical link set, one round-trip, and no giant IN-list params.
  // ORDER BY makes the per-memory entity order deterministic (the graph signal
  // is order-independent anyway — it only does max/set ops).
  const links = await db
    .select({ memoryId: memoryEntities.memoryId, entityId: memoryEntities.entityId })
    .from(memoryEntities)
    .innerJoin(memories, eq(memories.id, memoryEntities.memoryId))
    .innerJoin(entities, eq(entities.id, memoryEntities.entityId))
    .where(and(scopeMemories(scope), isNull(memories.forgottenAt), scopeEntities(scope)))
    .orderBy(asc(memoryEntities.memoryId), asc(memoryEntities.entityId));

  const result = new Map<number, number[]>();
  for (const { memoryId, entityId } of links) {
    const list = result.get(memoryId);
    if (list) list.push(entityId);
    else result.set(memoryId, [entityId]);
  }
  return result;
}

/**
 * Load the full scoped working set up front. We use the Postgres graph store,
 * so edges are fetched per-hop inside the BFS (`include_edges = false`).
 */
export async function loadRetrievalCandidates(
  db: Database,
  scope: TenantScope,
): Promise<RetrievalCandidates> {
  const [mems, ents, memoryToEntities] = await Promise.all([
    getRetrievalMemories(db, scope),
    getRetrievalEntities(db, scope),
    getMemoryToEntitiesMap(db, scope),
  ]);
  return { memories: mems, entities: ents, edges: [], memoryToEntities };
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
