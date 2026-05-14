import { memorySpaces, type MemorySpace } from '@crosmos/db';
import type { Database } from '@crosmos/db';

export const DEFAULT_SPACE_NAME = 'default';
export const DEFAULT_SPACE_DESCRIPTION = 'Default memory space';

export async function createSpace(
  db: Database,
  input: {
    userId: number;
    orgId: number;
    name: string;
    description?: string | null;
  },
): Promise<MemorySpace> {
  const [row] = await db
    .insert(memorySpaces)
    .values({
      userId: input.userId,
      orgId: input.orgId,
      name: input.name,
      description: input.description ?? null,
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
