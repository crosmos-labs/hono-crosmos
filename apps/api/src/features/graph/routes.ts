import { edges, entities, type Edge, type Entity } from '@crosmos/db';
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { and, count, eq, isNull } from 'drizzle-orm';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { HonoEnv } from '../../bindings';
import { getDb } from '../../db';
import { getCachedSpaceByUuid } from '../../lib/gate-cache';
import { scopeEdges, scopeEntities, type TenantScope } from '../../lib/scope';
import { ErrorResponseSchema } from '../../lib/zod-common';
import { requireAuth } from '../auth/middleware';
import { requirePrincipal } from '../auth/principal';
import { resolveReadVisibility } from '../visibility/service';
import {
  GraphStatsQuerySchema,
  GraphStatsResponseSchema,
  GraphViewportQuerySchema,
  GraphViewportResponseSchema,
} from './schemas';

export const graphRoutes = new OpenAPIHono<HonoEnv>();

type ApiContext = Context<HonoEnv>;

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

async function scopedSpace(c: ApiContext, spaceUuid: string) {
  const space = await getCachedSpaceByUuid(c, spaceUuid);
  if (!space || space.orgId !== c.var.activeOrgId) {
    throw new HTTPException(404, { message: 'Space not found' });
  }
  return space;
}

async function tenantScope(
  c: ApiContext,
  space: { id: number; orgId: number },
): Promise<TenantScope> {
  return {
    orgId: space.orgId,
    spaceId: space.id,
    userId: c.var.userId!,
    visibleUserIds: await resolveReadVisibility(getDb(c), {
      orgId: space.orgId,
      userId: c.var.userId!,
    }),
  };
}

async function activeEdges(db: ReturnType<typeof getDb>, scope: TenantScope) {
  return db
    .select()
    .from(edges)
    .where(and(scopeEdges(scope), isNull(edges.forgottenAt)));
}

function edgeCountMap(edgeRows: Edge[]) {
  const map = new Map<number, number>();
  for (const edge of edgeRows) {
    map.set(edge.sourceEntityId, (map.get(edge.sourceEntityId) ?? 0) + 1);
    map.set(edge.targetEntityId, (map.get(edge.targetEntityId) ?? 0) + 1);
  }
  return map;
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

graphRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['graph'],
    summary: 'Get graph viewport',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requirePrincipal] as const,
    request: { query: GraphViewportQuerySchema },
    responses: {
      200: {
        description: 'Graph viewport',
        content: { 'application/json': { schema: GraphViewportResponseSchema } },
      },
      404: {
        description: 'Space not found',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const query = c.req.valid('query');
    const db = getDb(c);
    const space = await scopedSpace(c, query.space_id);
    const scope = await tenantScope(c, space);
    const [entityRows, edgeRows] = await Promise.all([
      db.select().from(entities).where(scopeEntities(scope)),
      activeEdges(db, scope),
    ]);
    const counts = edgeCountMap(edgeRows);
    const sortedNodes = entityRows
      .sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0))
      .slice(query.offset, query.offset + query.limit);

    if (sortedNodes.length === 0) {
      return c.json({ nodes: [], edges: [], total_nodes: 0, total_edges: 0 }, 200);
    }

    const nodeIds = new Set(sortedNodes.map((node) => node.id));
    const uuidById = new Map(sortedNodes.map((node) => [node.id, node.uuid]));
    const viewportEdges = edgeRows
      .filter(
        (edge) =>
          nodeIds.has(edge.sourceEntityId) || nodeIds.has(edge.targetEntityId),
      )
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
      .slice(0, query.limit * 3);

    return c.json(
      {
        nodes: sortedNodes.map((node) => nodeOut(node, counts.get(node.id) ?? 0)),
        edges: viewportEdges.map((edge) => edgeOut(edge, uuidById)),
        total_nodes: entityRows.length,
        total_edges: edgeRows.length,
      },
      200,
    );
  },
);

graphRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/stats',
    tags: ['graph'],
    summary: 'Get graph stats',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requirePrincipal] as const,
    request: { query: GraphStatsQuerySchema },
    responses: {
      200: {
        description: 'Graph stats',
        content: { 'application/json': { schema: GraphStatsResponseSchema } },
      },
      404: {
        description: 'Space not found',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const query = c.req.valid('query');
    const db = getDb(c);
    const space = await scopedSpace(c, query.space_id);
    const scope = await tenantScope(c, space);
    const [entityRows, edgeRows, typeRows] = await Promise.all([
      db.select({ c: count() }).from(entities).where(scopeEntities(scope)),
      activeEdges(db, scope),
      db
        .select({ entityType: entities.entityType, c: count() })
        .from(entities)
        .where(scopeEntities(scope))
        .groupBy(entities.entityType),
    ]);

    const entityTypes: Record<string, number> = {};
    for (const row of typeRows) {
      entityTypes[row.entityType ?? 'unknown'] = row.c;
    }

    const relations = new Map<string, number>();
    for (const edge of edgeRows) {
      relations.set(edge.relationType, (relations.get(edge.relationType) ?? 0) + 1);
    }
    const topRelations = [...relations.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([relation, relationCount]) => ({ relation, count: relationCount }));

    return c.json(
      {
        total_entities: entityRows[0]?.c ?? 0,
        total_edges: edgeRows.length,
        entity_types: entityTypes,
        top_relations: topRelations,
      },
      200,
    );
  },
);
