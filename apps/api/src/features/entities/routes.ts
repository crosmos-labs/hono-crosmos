import {
  edges,
  entities,
  memories,
  memoryEntities,
  type Entity,
  type Memory,
} from '@crosmos/db';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, count, desc, eq, ilike, isNull } from 'drizzle-orm';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { HonoEnv } from '../../bindings';
import { getDb } from '../../db';
import { getCachedSpaceByUuid } from '../../lib/gate-cache';
import {
  memoryVisibilityClause,
  scopeEdges,
  scopeEntities,
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

export const entityRoutes = new OpenAPIHono<HonoEnv>();

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

async function edgeCountMap(db: ReturnType<typeof getDb>, scope: TenantScope) {
  const map = new Map<number, number>();
  const sourceRows = await db
    .select({ entityId: edges.sourceEntityId, c: count() })
    .from(edges)
    .where(and(scopeEdges(scope), isNull(edges.forgottenAt)))
    .groupBy(edges.sourceEntityId);
  const targetRows = await db
    .select({ entityId: edges.targetEntityId, c: count() })
    .from(edges)
    .where(and(scopeEdges(scope), isNull(edges.forgottenAt)))
    .groupBy(edges.targetEntityId);
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
    const counts = await edgeCountMap(db, scope);

    const rows = await db
      .select()
      .from(entities)
      .where(
        and(
          scopeEntities(scope),
          query.entity_type ? eq(entities.entityType, query.entity_type) : undefined,
          query.q ? ilike(entities.name, `%${query.q}%`) : undefined,
        ),
      );

    const direction = query.order === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      if (query.sort_by === 'edge_count') {
        return ((counts.get(a.id) ?? 0) - (counts.get(b.id) ?? 0)) * direction;
      }
      if (query.sort_by === 'created_at') {
        return (a.createdAt.getTime() - b.createdAt.getTime()) * direction;
      }
      return a.name.localeCompare(b.name) * direction;
    });

    const page = rows.slice(query.offset, query.offset + query.limit);
    return c.json(
      {
        entities: page.map((e) => toResponse(e, space.uuid, counts.get(e.id) ?? 0)),
        total: rows.length,
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

    const counts = await edgeCountMap(db, scope);
    const linkedMemories = await db
      .select({ memory: memories })
      .from(memories)
      .innerJoin(memoryEntities, eq(memoryEntities.memoryId, memories.id))
      .where(
        and(
          eq(memoryEntities.entityId, entity.id),
          eq(memories.spaceId, scope.spaceId),
          isNull(memories.forgottenAt),
          memoryVisibilityClause(scope),
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
