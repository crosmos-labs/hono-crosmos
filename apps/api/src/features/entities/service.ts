import {
  edges,
  entities,
  memories,
  memoryEntities,
  type Database,
} from '@crosmos/db';
import { and, asc, count, desc, eq, ilike, inArray, isNull, sql } from 'drizzle-orm';
import { scopeEdges, scopeEntities, scopeMemories, type TenantScope } from '../../lib/scope';

async function edgeCountMap(db: Database, scope: TenantScope, entityIds: number[]) {
  const result = new Map<number, number>();
  if (entityIds.length === 0) return result;
  const activeScoped = and(scopeEdges(scope), isNull(edges.forgottenAt));
  const [sourceRows, targetRows] = await Promise.all([
    db.select({ entityId: edges.sourceEntityId, count: count() })
      .from(edges)
      .where(and(activeScoped, inArray(edges.sourceEntityId, entityIds)))
      .groupBy(edges.sourceEntityId),
    db.select({ entityId: edges.targetEntityId, count: count() })
      .from(edges)
      .where(and(activeScoped, inArray(edges.targetEntityId, entityIds)))
      .groupBy(edges.targetEntityId),
  ]);
  for (const row of [...sourceRows, ...targetRows]) {
    result.set(row.entityId, (result.get(row.entityId) ?? 0) + row.count);
  }
  return result;
}

export async function listEntities(
  db: Database,
  scope: TenantScope,
  query: {
    entity_type?: string;
    q?: string;
    order: 'asc' | 'desc';
    sort_by: 'edge_count' | 'created_at' | 'name';
    limit: number;
    offset: number;
  },
) {
  const filter = and(
    scopeEntities(scope),
    query.entity_type ? eq(entities.entityType, query.entity_type) : undefined,
    query.q ? ilike(entities.name, `%${query.q}%`) : undefined,
  );
  const [totalRow] = await db.select({ count: count() }).from(entities).where(filter);
  const direction = query.order === 'asc' ? asc : desc;
  const visibleEdges = scopeEdges(scope);
  const edgeCount = sql<number>`(
    (SELECT count(*) FROM ${edges}
      WHERE ${edges.sourceEntityId} = ${entities.id}
        AND ${edges.forgottenAt} IS NULL
        AND ${visibleEdges})
    +
    (SELECT count(*) FROM ${edges}
      WHERE ${edges.targetEntityId} = ${entities.id}
        AND ${edges.forgottenAt} IS NULL
        AND ${visibleEdges})
  )::int`;
  const orderBy = query.sort_by === 'edge_count'
    ? [direction(edgeCount), asc(entities.id)]
    : query.sort_by === 'created_at'
      ? [direction(entities.createdAt), asc(entities.id)]
      : [direction(entities.name), asc(entities.id)];
  const rows = await db.select({ entity: entities, edgeCount })
    .from(entities)
    .where(filter)
    .orderBy(...orderBy)
    .limit(query.limit)
    .offset(query.offset);
  return { rows, total: totalRow?.count ?? 0 };
}

export async function getEntityDetail(
  db: Database,
  scope: TenantScope,
  uuid: string,
) {
  const [entity] = await db.select().from(entities)
    .where(and(scopeEntities(scope), eq(entities.uuid, uuid)))
    .limit(1);
  if (!entity) return null;
  const counts = await edgeCountMap(db, scope, [entity.id]);
  const linkedMemories = await db.select({ memory: memories })
    .from(memories)
    .innerJoin(memoryEntities, eq(memoryEntities.memoryId, memories.id))
    .where(and(
      eq(memoryEntities.entityId, entity.id),
      scopeMemories(scope),
      isNull(memories.forgottenAt),
    ))
    .orderBy(desc(memories.createdAt))
    .limit(10);
  return {
    entity,
    edgeCount: counts.get(entity.id) ?? 0,
    memories: linkedMemories.map((row) => row.memory),
  };
}
