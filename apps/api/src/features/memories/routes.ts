import { edges, memories, type Memory } from '@crosmos/db';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import type { HonoEnv } from '../../bindings';
import { getDb } from '../../db';
import { getCachedSpaceByUuid } from '../../lib/gate-cache';
import { scopeMemories, type TenantScope } from '../../lib/scope';
import { ErrorResponseSchema, UuidSchema } from '../../lib/zod-common';
import { requireAuth } from '../auth/middleware';
import { requirePrincipal } from '../auth/principal';
import { resolveReadVisibility } from '../visibility/service';
import {
  MemoryListQuerySchema,
  MemoryListResponseSchema,
  MemoryResponseSchema,
  SpaceScopedQuerySchema,
} from './schemas';

export const memoryRoutes = new OpenAPIHono<HonoEnv>();

function toResponse(memory: Memory, spaceUuid: string) {
  return {
    id: memory.uuid,
    space_id: spaceUuid,
    content: memory.content,
    memory_type: memory.memoryType,
    importance_score: memory.importanceScore ?? null,
    event_time: memory.eventTime?.toISOString() ?? null,
    meta: (memory.meta as Record<string, unknown> | null) ?? null,
    access_frequency: memory.accessFrequency,
    last_accessed_at: memory.lastAccessedAt.toISOString(),
    forgotten_at: memory.forgottenAt?.toISOString() ?? null,
    created_at: memory.createdAt.toISOString(),
  };
}

async function scopedSpace(c: Parameters<typeof getDb>[0], spaceUuid: string) {
  const space = await getCachedSpaceByUuid(c, spaceUuid);
  if (!space || space.orgId !== c.var.activeOrgId) {
    throw new HTTPException(404, { message: 'Space not found' });
  }
  return space;
}

async function tenantScope(
  c: Parameters<typeof getDb>[0],
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

function orderColumn(sortBy: string) {
  switch (sortBy) {
    case 'importance_score':
      return memories.importanceScore;
    case 'event_time':
      return memories.eventTime;
    case 'last_accessed_at':
      return memories.lastAccessedAt;
    case 'access_frequency':
      return memories.accessFrequency;
    default:
      return memories.createdAt;
  }
}

memoryRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['memories'],
    summary: 'List memories',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requirePrincipal] as const,
    request: { query: MemoryListQuerySchema },
    responses: {
      200: {
        description: 'Memories in a space',
        content: { 'application/json': { schema: MemoryListResponseSchema } },
      },
      401: {
        description: 'Unauthorized',
        content: { 'application/json': { schema: ErrorResponseSchema } },
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
    const sort = orderColumn(query.sort_by);

    const rows = await db
      .select()
      .from(memories)
      .where(
        and(
          scopeMemories(scope),
          isNull(memories.forgottenAt),
          query.memory_type ? eq(memories.memoryType, query.memory_type) : undefined,
        ),
      )
      .orderBy(query.order === 'asc' ? asc(sort) : desc(sort))
      .limit(query.limit)
      .offset(query.offset);

    return c.json(
      { memories: rows.map((m) => toResponse(m, space.uuid)), count: rows.length },
      200,
    );
  },
);

memoryRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/{memory_uuid}',
    tags: ['memories'],
    summary: 'Get memory',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requirePrincipal] as const,
    request: {
      params: z.object({ memory_uuid: UuidSchema }),
      query: SpaceScopedQuerySchema,
    },
    responses: {
      200: {
        description: 'Memory',
        content: { 'application/json': { schema: MemoryResponseSchema } },
      },
      404: {
        description: 'Memory not found',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const { memory_uuid } = c.req.valid('param');
    const { space_id } = c.req.valid('query');
    const db = getDb(c);
    const space = await scopedSpace(c, space_id);
    const scope = await tenantScope(c, space);
    const [memory] = await db
      .select()
      .from(memories)
      .where(
        and(
          scopeMemories(scope),
          eq(memories.uuid, memory_uuid),
          isNull(memories.forgottenAt),
        ),
      )
      .limit(1);
    if (!memory) {
      throw new HTTPException(404, { message: `Memory ${memory_uuid} not found` });
    }
    return c.json(toResponse(memory, space.uuid), 200);
  },
);

memoryRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/{memory_uuid}',
    tags: ['memories'],
    summary: 'Forget memory',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requirePrincipal] as const,
    request: {
      params: z.object({ memory_uuid: UuidSchema }),
      query: SpaceScopedQuerySchema,
    },
    responses: {
      204: { description: 'Forgotten' },
      404: {
        description: 'Memory not found',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const { memory_uuid } = c.req.valid('param');
    const { space_id } = c.req.valid('query');
    const db = getDb(c);
    const space = await scopedSpace(c, space_id);
    const scope = await tenantScope(c, space);
    const [memory] = await db
      .select({ id: memories.id })
      .from(memories)
      .where(and(scopeMemories(scope), eq(memories.uuid, memory_uuid)))
      .limit(1);
    if (!memory) {
      throw new HTTPException(404, { message: `Memory ${memory_uuid} not found` });
    }

    const now = new Date();
    await db
      .update(memories)
      .set({ forgottenAt: now, updatedAt: now })
      .where(eq(memories.id, memory.id));
    await db
      .update(edges)
      .set({ forgottenAt: now })
      .where(eq(edges.memoryId, memory.id));

    return c.body(null, 204);
  },
);
