import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { createApiApp } from '../../lib/openapi';
import { getDb } from '../../db';
import { requireAuth } from '../auth/middleware';
import { requirePrincipal } from '../auth/principal';
import { getSpaceByUuid } from '../spaces/service';
import { assertKeyScopeAllowsSpace } from '../../lib/key-scope';
import { AnalyticsQuerySchema, AnalyticsResponseSchema } from './schemas';
import { getAnalytics } from './service';

export const analyticsRoutes = createApiApp();

analyticsRoutes.openapi(createRoute({
  method: 'get', path: '/summary', tags: ['analytics'], security: [{ bearerAuth: [] }],
  summary: 'Get organization analytics',
  middleware: [requireAuth, requirePrincipal] as const,
  request: { query: AnalyticsQuerySchema },
  responses: { 200: { description: 'Current and previous-window analytics', content: { 'application/json': { schema: AnalyticsResponseSchema } } } },
}), async (c) => {
  const { days } = c.req.valid('query');
  return c.json(await getAnalytics(getDb(c), { orgId: c.var.activeOrgId!, days }), 200);
});

export const spaceAnalyticsRoutes = createApiApp();
spaceAnalyticsRoutes.openapi(createRoute({
  method: 'get', path: '/{space_uuid}/analytics', tags: ['analytics'], security: [{ bearerAuth: [] }],
  summary: 'Get analytics for one active space',
  middleware: [requireAuth, requirePrincipal] as const,
  request: {
    params: z.object({ space_uuid: z.string().uuid() }),
    query: AnalyticsQuerySchema,
  },
  responses: { 200: { description: 'Space analytics', content: { 'application/json': { schema: AnalyticsResponseSchema } } } },
}), async (c) => {
  const db = getDb(c);
  const space = await getSpaceByUuid(db, c.req.valid('param').space_uuid);
  if (!space || space.orgId !== c.var.activeOrgId) throw new HTTPException(404, { message: 'Space not found' });
  assertKeyScopeAllowsSpace(c, space.id);
  const { days } = c.req.valid('query');
  return c.json(await getAnalytics(db, { orgId: space.orgId, spaceId: space.id, days }), 200);
});
