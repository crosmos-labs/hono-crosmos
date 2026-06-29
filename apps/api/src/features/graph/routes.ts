import { edges, entities, type Edge, type Entity } from '@crosmos/db';
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { createApiApp } from '../../lib/openapi';
import { and, asc, count, desc, inArray, isNull, or, sql } from 'drizzle-orm';
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

export const graphRoutes = createApiApp();

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

/**
 * DB-side active-edge degree for an entity (source + target appearances),
 * correlated to the scoped/active/visible edge set. Lets the viewport ORDER BY
 * degree and LIMIT/OFFSET in SQL instead of materializing every entity + edge.
 * Applies the SAME visibility filter as `scopeEdges` so the count never leaks
 * edges the caller can't see (matches the previous JS-map behaviour exactly).
 */
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

/**
 * EXISTS predicate: the entity is touched by at least one active edge the caller
 * can see. Entities carry no owner/visibility columns, so without this they all
 * render regardless of who can see their edges — producing an orphan node-cloud
 * with edge_count 0 (e.g. when viewing another org's space whose content is
 * private to other users). Gating nodes on a visible edge keeps the node set
 * consistent with the visibility-filtered edge set (same filter as `scopeEdges`).
 * Note: entities with no active edges at all are also excluded — the graph view
 * shows the visible relationship subgraph, not isolated nodes.
 */
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

    const degree = edgeCountExpr(scope);
    // Totals via COUNT — never materialize the whole space to read `.length`.
    const [[nodeTotalRow], [edgeTotalRow], pageNodes] = await Promise.all([
      db
        .select({ c: count() })
        .from(entities)
        .where(and(scopeEntities(scope), hasVisibleEdge(scope))),
      db
        .select({ c: count() })
        .from(edges)
        .where(and(scopeEdges(scope), isNull(edges.forgottenAt))),
      // Node page ordered by degree DESC, paginated in SQL. `id` tiebreak keeps
      // the order stable across pages.
      db
        .select({ entity: entities, edgeCount: degree })
        .from(entities)
        .where(and(scopeEntities(scope), hasVisibleEdge(scope)))
        .orderBy(desc(degree), asc(entities.id))
        .limit(query.limit)
        .offset(query.offset),
    ]);

    const totalNodes = nodeTotalRow?.c ?? 0;
    const totalEdges = edgeTotalRow?.c ?? 0;

    if (pageNodes.length === 0) {
      return c.json(
        { nodes: [], edges: [], total_nodes: totalNodes, total_edges: totalEdges },
        200,
      );
    }

    const nodeIds = pageNodes.map((row) => row.entity.id);
    const uuidById = new Map(pageNodes.map((row) => [row.entity.id, row.entity.uuid]));

    // Fetch only edges incident to the selected node page (not the whole edge
    // table), highest-confidence first, bounded like before.
    const viewportEdges = await db
      .select()
      .from(edges)
      .where(
        and(
          scopeEdges(scope),
          isNull(edges.forgottenAt),
          or(
            inArray(edges.sourceEntityId, nodeIds),
            inArray(edges.targetEntityId, nodeIds),
          ),
        ),
      )
      .orderBy(desc(edges.confidence))
      .limit(query.limit * 3);

    return c.json(
      {
        nodes: pageNodes.map((row) => nodeOut(row.entity, row.edgeCount ?? 0)),
        edges: viewportEdges.map((edge) => edgeOut(edge, uuidById)),
        total_nodes: totalNodes,
        total_edges: totalEdges,
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
      db
        .select({ c: count() })
        .from(entities)
        .where(and(scopeEntities(scope), hasVisibleEdge(scope))),
      activeEdges(db, scope),
      db
        .select({ entityType: entities.entityType, c: count() })
        .from(entities)
        .where(and(scopeEntities(scope), hasVisibleEdge(scope)))
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
