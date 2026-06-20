import {
  entities,
  memories,
  memorySpaces,
  organizations,
  type MemorySpace,
} from '@crosmos/db';
import type { Database } from '@crosmos/db';
import { and, asc, count, eq, gt } from 'drizzle-orm';

export const DEFAULT_SPACE_NAME = 'default';
export const DEFAULT_SPACE_DESCRIPTION = 'Default memory space';

export async function createSpace(
  db: Database,
  input: {
    userId: number;
    orgId: number;
    name: string;
    description?: string | null;
    meta?: Record<string, unknown> | null;
  },
): Promise<MemorySpace> {
  const [row] = await db
    .insert(memorySpaces)
    .values({
      userId: input.userId,
      orgId: input.orgId,
      name: input.name,
      description: input.description ?? null,
      meta: input.meta ?? null,
    })
    .returning();
  if (!row) throw new Error('Failed to create memory space');
  return row;
}

/** Sentinel returned by `createSpaceAtomic` when the org is at its space cap. */
export const SPACE_QUOTA_EXCEEDED = Symbol('space_quota_exceeded');

/**
 * Atomically create a space iff the org is under `limit` existing spaces.
 *
 * The previous count-then-insert was a TOCTOU race: N concurrent creates each
 * read the same pre-insert count and all passed the cap. We close the window by
 * running the count + insert inside a transaction that holds a `SELECT ... FOR
 * UPDATE` row lock on the org. Concurrent creates for the SAME org serialize on
 * that lock — each sees the rows the prior one committed — so the cap can't be
 * overrun; creates for different orgs don't contend. On overrun we return the
 * `SPACE_QUOTA_EXCEEDED` sentinel (the route maps it to the existing 429 body).
 *
 * `limit < 0` means unlimited (entitlement `-1`); callers pass the resolved
 * entitlement value. The unique `(org_id, name)` index still rejects duplicate
 * names independently of this check.
 */
export async function createSpaceAtomic(
  db: Database,
  input: {
    userId: number;
    orgId: number;
    name: string;
    description?: string | null;
    meta?: Record<string, unknown> | null;
    limit: number;
  },
): Promise<MemorySpace | typeof SPACE_QUOTA_EXCEEDED> {
  // Unlimited plans skip the guard entirely (plain insert).
  if (input.limit < 0) {
    return createSpace(db, input);
  }

  // The previous count-then-insert was a TOCTOU race: N concurrent creates each
  // read the same pre-insert count and all passed the cap. We close the window by
  // taking a row lock on the org for the duration of the count+insert. Concurrent
  // creates for the SAME org serialize on this lock, so each sees the rows the
  // prior one committed; creates for different orgs don't contend.
  return db.transaction(async (tx) => {
    // SELECT ... FOR UPDATE on the org row — held until the txn commits.
    await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, input.orgId))
      .limit(1)
      .for('update');

    const countRows = await tx
      .select({ c: count() })
      .from(memorySpaces)
      .where(eq(memorySpaces.orgId, input.orgId));
    const c = countRows[0]?.c ?? 0;

    if (c >= input.limit) {
      return SPACE_QUOTA_EXCEEDED;
    }

    const [row] = await tx
      .insert(memorySpaces)
      .values({
        userId: input.userId,
        orgId: input.orgId,
        name: input.name,
        description: input.description ?? null,
        meta: input.meta ?? null,
      })
      .returning();
    if (!row) throw new Error('Failed to create memory space');
    return row;
  });
}

export async function createDefaultSpace(
  db: Database,
  input: { userId: number; orgId: number },
): Promise<MemorySpace> {
  return createSpace(db, {
    ...input,
    name: DEFAULT_SPACE_NAME,
    description: DEFAULT_SPACE_DESCRIPTION,
  });
}

export async function getSpaceById(
  db: Database,
  input: { orgId: number; spaceId: number },
): Promise<MemorySpace | null> {
  const rows = await db
    .select()
    .from(memorySpaces)
    .where(
      and(eq(memorySpaces.orgId, input.orgId), eq(memorySpaces.id, input.spaceId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Looks up a space by UUID (no org scope check). Routes that use this MUST
 * verify `space.orgId === principal.orgId` and 404 on mismatch (matches
 * Python's `verify_space_access_by_uuid`).
 */
export async function getSpaceByUuid(
  db: Database,
  spaceUuid: string,
): Promise<MemorySpace | null> {
  const rows = await db
    .select()
    .from(memorySpaces)
    .where(eq(memorySpaces.uuid, spaceUuid))
    .limit(1);
  return rows[0] ?? null;
}

export async function getSpaceByName(
  db: Database,
  input: { orgId: number; name: string },
): Promise<MemorySpace | null> {
  const rows = await db
    .select()
    .from(memorySpaces)
    .where(and(eq(memorySpaces.orgId, input.orgId), eq(memorySpaces.name, input.name)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Mirrors `list_spaces` in Python: order by created_at ASC, optional exact
 * `name` filter (names are unique per org so this returns 0 or 1).
 */
export async function listSpaces(
  db: Database,
  input: { orgId: number; name?: string | null; limit?: number; offset?: number },
): Promise<MemorySpace[]> {
  const limit = input.limit ?? 100;
  const offset = input.offset ?? 0;

  const whereClause =
    input.name != null
      ? and(eq(memorySpaces.orgId, input.orgId), eq(memorySpaces.name, input.name))
      : eq(memorySpaces.orgId, input.orgId);

  return db
    .select()
    .from(memorySpaces)
    .where(whereClause)
    .orderBy(asc(memorySpaces.createdAt))
    .limit(limit)
    .offset(offset);
}

export async function countSpaces(
  db: Database,
  orgId: number,
): Promise<number> {
  const rows = await db
    .select({ c: count() })
    .from(memorySpaces)
    .where(eq(memorySpaces.orgId, orgId));
  return rows[0]?.c ?? 0;
}

/** Page size for collecting vector ids before a space delete (bounds memory). */
const VECTOR_ID_COLLECT_PAGE = 5000;

/**
 * Keyset-paginate all `memories.id` in a space, ordered by id asc, so we never
 * load an unbounded array for a large space. The space's FK cascade physically
 * removes these rows, so their vectors must be purged from the external vector
 * store (Vectorize) by the caller.
 */
async function collectSpaceMemoryIds(
  db: Database,
  orgId: number,
  spaceId: number,
): Promise<number[]> {
  const ids: number[] = [];
  let cursor = 0;
  for (;;) {
    const rows = await db
      .select({ id: memories.id })
      .from(memories)
      .where(
        and(
          eq(memories.orgId, orgId),
          eq(memories.spaceId, spaceId),
          gt(memories.id, cursor),
        ),
      )
      .orderBy(asc(memories.id))
      .limit(VECTOR_ID_COLLECT_PAGE);
    if (rows.length === 0) break;
    for (const r of rows) ids.push(r.id);
    cursor = rows[rows.length - 1]!.id;
    if (rows.length < VECTOR_ID_COLLECT_PAGE) break;
  }
  return ids;
}

/** Same as `collectSpaceMemoryIds` for `entities` (also space-scoped). */
async function collectSpaceEntityIds(
  db: Database,
  orgId: number,
  spaceId: number,
): Promise<number[]> {
  const ids: number[] = [];
  let cursor = 0;
  for (;;) {
    const rows = await db
      .select({ id: entities.id })
      .from(entities)
      .where(
        and(
          eq(entities.orgId, orgId),
          eq(entities.spaceId, spaceId),
          gt(entities.id, cursor),
        ),
      )
      .orderBy(asc(entities.id))
      .limit(VECTOR_ID_COLLECT_PAGE);
    if (rows.length === 0) break;
    for (const r of rows) ids.push(r.id);
    cursor = rows[rows.length - 1]!.id;
    if (rows.length < VECTOR_ID_COLLECT_PAGE) break;
  }
  return ids;
}

export interface DeleteSpaceResult {
  deleted: boolean;
  /** Memory ids whose vectors must be purged from the external vector store. */
  memoryIds: number[];
  /**
   * Entity ids whose vectors must be purged. Unlike a single-source delete,
   * entities ARE space-scoped and the space's FK cascade physically removes
   * them, so their vectors are orphaned too and must be deleted.
   */
  entityIds: number[];
}

/**
 * Mirrors Python: cascade handles sources/memories/entities/edges via FK rules
 * already set in our Drizzle schema (onDelete: 'cascade').
 *
 * Returns the memory + entity ids removed so the caller can purge their vectors
 * from the external vector store (the DB cascade can't reach the index). Ids are
 * collected via keyset pagination so a large space doesn't load an unbounded
 * array into memory.
 */
export async function deleteSpace(
  db: Database,
  input: { orgId: number; spaceId: number },
): Promise<DeleteSpaceResult> {
  // Collect ids BEFORE the delete — the cascade makes the rows unreachable.
  const [memoryIds, entityIds] = await Promise.all([
    collectSpaceMemoryIds(db, input.orgId, input.spaceId),
    collectSpaceEntityIds(db, input.orgId, input.spaceId),
  ]);

  const deleted = await db
    .delete(memorySpaces)
    .where(
      and(eq(memorySpaces.orgId, input.orgId), eq(memorySpaces.id, input.spaceId)),
    )
    .returning({ id: memorySpaces.id });
  const ok = deleted.length > 0;
  return {
    deleted: ok,
    memoryIds: ok ? memoryIds : [],
    entityIds: ok ? entityIds : [],
  };
}
