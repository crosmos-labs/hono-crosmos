import {
  edges,
  entities,
  memories,
  memoryEntities,
  type Entity,
  type Memory,
} from '@crosmos/db';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { createApiApp } from '../../lib/openapi';
import { and, asc, count, desc, eq, ilike, inArray, isNull, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { HonoEnv } from '../../bindings';
import { getDb } from '../../db';
import { getCachedSpaceByUuid } from '../../lib/gate-cache';
import {
  scopeEdges,
  scopeEntities,
  scopeMemories,
  type TenantScope,
} from '../../lib/scope';
import { ErrorResponseSchema, UuidSchema } from '../../lib/zod-common';
import { requireAuth } from '../auth/middleware';
import { requirePrincipal } from '../auth/principal';
import { resolveReadVisibility } from '../visibility/service';
import {
  EntityDetailQuerySchema,
  EntityDetailResponseSchema,
  EntityListQuerySchema,
  EntityListResponseSchema,
} from './schemas';

export const entityRoutes = createApiApp();

type ApiContext = Context<HonoEnv>;

function toResponse(entity: Entity, spaceUuid: string, edgeCount: number) {
  return {
    id: entity.uuid,
    space_id: spaceUuid,
    name: entity.name,
    entity_type: entity.entityType ?? null,
    edge_count: edgeCount,
    created_at: entity.createdAt.toISOString(),
    updated_at: entity.updatedAt.toISOString(),
  };
}

function toMemory(memory: Memory) {
  return {
    memory_id: memory.uuid,
    content: memory.content,
    memory_type: memory.memoryType,
    created_at: memory.createdAt.toISOString(),
  };
}

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

/**
 * Active-edge counts (source + target appearances) for a bounded set of entity
 * IDs. Restricting the GROUP BY to the page's entities keeps this off the
 * whole-space edge table — we only count edges incident to the rows we return.
 */
async function edgeCountMap(
  db: ReturnType<typeof getDb>,
  scope: TenantScope,
  entityIds: number[],
) {
  const map = new Map<number, number>();
  if (entityIds.length === 0) return map;
  const activeScoped = and(scopeEdges(scope), isNull(edges.forgottenAt));
  const [sourceRows, targetRows] = await Promise.all([
    db
      .select({ entityId: edges.sourceEntityId, c: count() })
      .from(edges)
      .where(and(activeScoped, inArray(edges.sourceEntityId, entityIds)))
      .groupBy(edges.sourceEntityId),
    db
      .select({ entityId: edges.targetEntityId, c: count() })
      .from(edges)
      .where(and(activeScoped, inArray(edges.targetEntityId, entityIds)))
      .groupBy(edges.targetEntityId),
  ]);
  for (const row of [...sourceRows, ...targetRows]) {
    map.set(row.entityId, (map.get(row.entityId) ?? 0) + row.c);
  }
  return map;
}

entityRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['entities'],
    summary: 'List entities',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requirePrincipal] as const,
    request: { query: EntityListQuerySchema },
    responses: {
      200: {
        description: 'Entities',
        content: { 'application/json': { schema: EntityListResponseSchema } },
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

    const filter = and(
      scopeEntities(scope),
      query.entity_type ? eq(entities.entityType, query.entity_type) : undefined,
      query.q ? ilike(entities.name, `%${query.q}%`) : undefined,
    );

    // `total` via a dedicated COUNT — never materialize the whole space.
    const [totalRow] = await db
      .select({ c: count() })
      .from(entities)
      .where(filter);
    const total = totalRow?.c ?? 0;

    const dir = query.order === 'asc' ? asc : desc;
    // DB-side active-edge count per entity (source + target appearances),
    // correlated to the scoped/active/visible edge set (same visibility filter
    // as `scopeEdges`, so the count matches the previous JS behaviour and never
    // leaks edges the caller can't see). Used both to ORDER BY in SQL for the
    // edge_count sort and to populate the response without a second whole-table
    // scan.
    const visibleEdges = scopeEdges(scope);
    const edgeCountExpr = sql<number>`(
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

    const orderBy =
      query.sort_by === 'edge_count'
        ? [dir(edgeCountExpr), asc(entities.id)]
        : query.sort_by === 'created_at'
          ? [dir(entities.createdAt), asc(entities.id)]
          : [dir(entities.name), asc(entities.id)];

    // Push pagination + ordering into SQL; only the page is loaded into memory.
    const rows = await db
      .select({ entity: entities, edgeCount: edgeCountExpr })
      .from(entities)
      .where(filter)
      .orderBy(...orderBy)
      .limit(query.limit)
      .offset(query.offset);

    return c.json(
      {
        entities: rows.map((row) =>
          toResponse(row.entity, space.uuid, row.edgeCount ?? 0),
        ),
        total,
      },
      200,
    );
  },
);

entityRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/{entity_uuid}',
    tags: ['entities'],
    summary: 'Get entity',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requirePrincipal] as const,
    request: {
      params: z.object({ entity_uuid: UuidSchema }),
      query: EntityDetailQuerySchema,
    },
    responses: {
      200: {
        description: 'Entity detail',
        content: { 'application/json': { schema: EntityDetailResponseSchema } },
      },
      404: {
        description: 'Entity not found',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const { entity_uuid } = c.req.valid('param');
    const { space_id } = c.req.valid('query');
    const db = getDb(c);
    const space = await scopedSpace(c, space_id);
    const scope = await tenantScope(c, space);
    const [entity] = await db
      .select()
      .from(entities)
      .where(and(scopeEntities(scope), eq(entities.uuid, entity_uuid)))
      .limit(1);
    if (!entity) {
      throw new HTTPException(404, { message: `Entity ${entity_uuid} not found` });
    }

    const counts = await edgeCountMap(db, scope, [entity.id]);
    const linkedMemories = await db
      .select({ memory: memories })
      .from(memories)
      .innerJoin(memoryEntities, eq(memoryEntities.memoryId, memories.id))
      .where(
        and(
          eq(memoryEntities.entityId, entity.id),
          scopeMemories(scope),
          isNull(memories.forgottenAt),
        ),
      )
      .orderBy(desc(memories.createdAt))
      .limit(10);

    return c.json(
      {
        ...toResponse(entity, space.uuid, counts.get(entity.id) ?? 0),
        memories: linkedMemories.map((row) => toMemory(row.memory)),
      },
      200,
    );
  },
);
