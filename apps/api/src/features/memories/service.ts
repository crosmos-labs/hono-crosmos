import { edges, memories, type Database, type Memory } from '@crosmos/db';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { scopeMemories, type TenantScope } from '../../lib/scope';

function orderColumn(sortBy: string) {
  switch (sortBy) {
    case 'importance_score': return memories.importanceScore;
    case 'event_time': return memories.eventTime;
    case 'last_accessed_at': return memories.lastAccessedAt;
    case 'access_frequency': return memories.accessFrequency;
    default: return memories.createdAt;
  }
}

export function listMemories(
  db: Database,
  scope: TenantScope,
  query: {
    memory_type?: Memory['memoryType'];
    sort_by: string;
    order: 'asc' | 'desc';
    limit: number;
    offset: number;
  },
) {
  const sort = orderColumn(query.sort_by);
  return db
    .select()
    .from(memories)
    .where(and(
      scopeMemories(scope),
      isNull(memories.forgottenAt),
      query.memory_type ? eq(memories.memoryType, query.memory_type) : undefined,
    ))
    .orderBy(query.order === 'asc' ? asc(sort) : desc(sort))
    .limit(query.limit)
    .offset(query.offset);
}

export async function getMemory(db: Database, scope: TenantScope, uuid: string) {
  const [memory] = await db
    .select()
    .from(memories)
    .where(and(
      scopeMemories(scope),
      eq(memories.uuid, uuid),
      isNull(memories.forgottenAt),
    ))
    .limit(1);
  return memory ?? null;
}

export async function forgetMemory(db: Database, scope: TenantScope, uuid: string) {
  const [memory] = await db
    .select({ id: memories.id })
    .from(memories)
    .where(and(scopeMemories(scope), eq(memories.uuid, uuid)))
    .limit(1);
  if (!memory) return false;
  const now = new Date();
  await db.update(memories)
    .set({ forgottenAt: now, updatedAt: now })
    .where(eq(memories.id, memory.id));
  await db.update(edges).set({ forgottenAt: now }).where(eq(edges.memoryId, memory.id));
  return true;
}
