import { edges, entities, type Database, type Edge, type Entity } from '@crosmos/db';
import { and, asc, count, desc, inArray, isNull, or, sql } from 'drizzle-orm';
import { scopeEdges, scopeEntities, type TenantScope } from '../../lib/scope';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

function edgeCountExpr(scope: TenantScope) {
  const visible = scopeEdges(scope);
  return sql<number>`(
    (SELECT count(*) FROM ${edges}
      WHERE ${edges.sourceEntityId} = ${entities.id}
        AND ${edges.forgottenAt} IS NULL
        AND ${visible})
    +
    (SELECT count(*) FROM ${edges}
      WHERE ${edges.targetEntityId} = ${entities.id}
        AND ${edges.forgottenAt} IS NULL
        AND ${visible})
  )::int`;
}

function hasVisibleEdge(scope: TenantScope) {
  const visible = scopeEdges(scope);
  return sql`EXISTS (
    SELECT 1 FROM ${edges}
    WHERE (${edges.sourceEntityId} = ${entities.id}
        OR ${edges.targetEntityId} = ${entities.id})
      AND ${edges.forgottenAt} IS NULL
      AND ${visible}
  )`;
}

function nodeOut(entity: Entity, countForEntity: number) {
  return {
    id: entity.uuid,
    name: entity.name,
    entity_type: entity.entityType ?? null,
    edge_count: countForEntity,
    created_at: entity.createdAt?.toISOString() ?? null,
    updated_at: entity.updatedAt?.toISOString() ?? null,
  };
}

function edgeOut(edge: Edge, uuidById: Map<number, string>) {
  return {
    id: edge.uuid,
    source_entity_id: uuidById.get(edge.sourceEntityId) ?? ZERO_UUID,
    target_entity_id: uuidById.get(edge.targetEntityId) ?? ZERO_UUID,
    relation_type: edge.relationType,
    confidence: edge.confidence ?? 0,
    valid_from: edge.validFrom?.toISOString() ?? null,
    recorded_at: edge.recordedAt.toISOString(),
  };
}

export async function getGraphViewport(
  db: Database,
  scope: TenantScope,
  query: { limit: number; offset: number },
) {
  const degree = edgeCountExpr(scope);
  const [[nodeTotalRow], [edgeTotalRow], pageNodes] = await Promise.all([
    db.select({ c: count() })
      .from(entities)
      .where(and(scopeEntities(scope), hasVisibleEdge(scope))),
    db.select({ c: count() })
      .from(edges)
      .where(and(scopeEdges(scope), isNull(edges.forgottenAt))),
    db.select({ entity: entities, edgeCount: degree })
      .from(entities)
      .where(and(scopeEntities(scope), hasVisibleEdge(scope)))
      .orderBy(desc(degree), asc(entities.id))
      .limit(query.limit)
      .offset(query.offset),
  ]);

  const totalNodes = nodeTotalRow?.c ?? 0;
  const totalEdges = edgeTotalRow?.c ?? 0;
  if (pageNodes.length === 0) {
    return { nodes: [], edges: [], total_nodes: totalNodes, total_edges: totalEdges };
  }

  const nodeIds = pageNodes.map((row) => row.entity.id);
  const uuidById = new Map(pageNodes.map((row) => [row.entity.id, row.entity.uuid]));
  const viewportEdges = await db.select()
    .from(edges)
    .where(and(
      scopeEdges(scope),
      isNull(edges.forgottenAt),
      or(
        inArray(edges.sourceEntityId, nodeIds),
        inArray(edges.targetEntityId, nodeIds),
      ),
    ))
    .orderBy(desc(edges.confidence))
    .limit(query.limit * 3);

  return {
    nodes: pageNodes.map((row) => nodeOut(row.entity, row.edgeCount ?? 0)),
    edges: viewportEdges.map((edge) => edgeOut(edge, uuidById)),
    total_nodes: totalNodes,
    total_edges: totalEdges,
  };
}

export async function getGraphStats(db: Database, scope: TenantScope) {
  const [entityRows, edgeRows, typeRows] = await Promise.all([
    db.select({ c: count() })
      .from(entities)
      .where(and(scopeEntities(scope), hasVisibleEdge(scope))),
    db.select()
      .from(edges)
      .where(and(scopeEdges(scope), isNull(edges.forgottenAt))),
    db.select({ entityType: entities.entityType, c: count() })
      .from(entities)
      .where(and(scopeEntities(scope), hasVisibleEdge(scope)))
      .groupBy(entities.entityType),
  ]);

  const entityTypes: Record<string, number> = {};
  for (const row of typeRows) entityTypes[row.entityType ?? 'unknown'] = row.c;

  const relations = new Map<string, number>();
  for (const edge of edgeRows) {
    relations.set(edge.relationType, (relations.get(edge.relationType) ?? 0) + 1);
  }
  const topRelations = [...relations.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([relation, relationCount]) => ({ relation, count: relationCount }));

  return {
    total_entities: entityRows[0]?.c ?? 0,
    total_edges: edgeRows.length,
    entity_types: entityTypes,
    top_relations: topRelations,
  };
}
