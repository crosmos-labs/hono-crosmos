import { memorySpaces, type MemorySpace } from '@crosmos/db';
import type { Database } from '@crosmos/db';
import { and, asc, count, eq } from 'drizzle-orm';

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

/**
 * Mirrors Python: cascade handles sources/memories/entities/edges via FK rules
 * already set in our Drizzle schema (onDelete: 'cascade').
 */
export async function deleteSpace(
  db: Database,
  input: { orgId: number; spaceId: number },
): Promise<boolean> {
  const deleted = await db
    .delete(memorySpaces)
    .where(
      and(eq(memorySpaces.orgId, input.orgId), eq(memorySpaces.id, input.spaceId)),
    )
    .returning({ id: memorySpaces.id });
  return deleted.length > 0;
}
