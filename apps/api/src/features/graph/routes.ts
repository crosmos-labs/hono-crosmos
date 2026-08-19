import { createRoute } from '@hono/zod-openapi';
import { createApiApp } from '../../lib/openapi';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { HonoEnv } from '../../bindings';
import { assertKeyScopeAllowsSpace } from '../../lib/key-scope';
import { getDb } from '../../db';
import { getCachedSpaceByUuid } from '../../lib/gate-cache';
import type { TenantScope } from '../../lib/scope';
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
import { getGraphStats, getGraphViewport } from './service';

export const graphRoutes = createApiApp();

type ApiContext = Context<HonoEnv>;

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

    return c.json(await getGraphViewport(db, scope, query), 200);
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
    return c.json(await getGraphStats(db, scope), 200);
  },
);
