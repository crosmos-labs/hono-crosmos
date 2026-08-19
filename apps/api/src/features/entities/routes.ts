import type { Entity, Memory } from '@crosmos/db';
import { createRoute, z } from '@hono/zod-openapi';
import { createApiApp } from '../../lib/openapi';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { HonoEnv } from '../../bindings';
import { assertKeyScopeAllowsSpace } from '../../lib/key-scope';
import { getDb } from '../../db';
import { getCachedSpaceByUuid } from '../../lib/gate-cache';
import type { TenantScope } from '../../lib/scope';
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
import { getEntityDetail, listEntities } from './service';

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
  // A space-scoped API key may only read its pinned space (no-op otherwise).
  assertKeyScopeAllowsSpace(c, space.id);
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

    const { rows, total } = await listEntities(db, scope, query);

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
    const detail = await getEntityDetail(db, scope, entity_uuid);
    if (!detail) {
      throw new HTTPException(404, { message: `Entity ${entity_uuid} not found` });
    }

    return c.json(
      {
        ...toResponse(detail.entity, space.uuid, detail.edgeCount),
        memories: detail.memories.map(toMemory),
      },
      200,
    );
  },
);
