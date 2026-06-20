import { dailyUsage, memorySpaces } from '@crosmos/db';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { createApiApp } from '../../lib/openapi';
import { and, count, eq, gte, lte, sum } from 'drizzle-orm';
import type { HonoEnv } from '../../bindings';
import { getDb } from '../../db';
import { getCachedEntitlements } from '../../lib/gate-cache';
import { ErrorResponseSchema } from '../../lib/zod-common';
import { requireAuth } from '../auth/middleware';
import { requirePrincipal } from '../auth/principal';
import { getOrganizationByIdOrThrow } from '../orgs/service';
import { UsageQuerySchema, UsageResponseSchema } from './schemas';

export const usageRoutes = createApiApp();

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function defaultPeriod(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return { start: isoDate(start), end: isoDate(end) };
}

function metric(used: number, limit: number) {
  return {
    used,
    limit,
    remaining: limit === -1 ? -1 : Math.max(limit - used, 0),
  };
}

function entitlementNumber(
  entitlements: Record<string, number | boolean | string>,
  key: string,
): number {
  const raw = entitlements[key];
  return typeof raw === 'number' ? raw : -1;
}

usageRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['usage'],
    summary: 'Get org usage',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requirePrincipal] as const,
    request: {
      query: UsageQuerySchema,
    },
    responses: {
      200: {
        description: 'Org usage for the selected period',
        content: { 'application/json': { schema: UsageResponseSchema } },
      },
      401: {
        description: 'Unauthorized',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const query = c.req.valid('query');
    const { start, end } = defaultPeriod();
    const periodStart = query.start_date ?? start;
    const periodEnd = query.end_date ?? end;
    const db = getDb(c);
    const orgId = c.var.activeOrgId!;

    const org = await getOrganizationByIdOrThrow(db, orgId);
    const entitlements = await getCachedEntitlements(c, orgId);

    const [usageRow] = await db
      .select({
        tokens: sum(dailyUsage.tokensIngested),
        queries: sum(dailyUsage.searchQueries),
      })
      .from(dailyUsage)
      .where(
        and(
          eq(dailyUsage.orgId, orgId),
          gte(dailyUsage.date, periodStart),
          lte(dailyUsage.date, periodEnd),
        ),
      );

    const [spaceRow] = await db
      .select({ c: count() })
      .from(memorySpaces)
      .where(eq(memorySpaces.orgId, orgId));

    const tokensUsed = Number(usageRow?.tokens ?? 0);
    const queriesUsed = Number(usageRow?.queries ?? 0);
    const spacesUsed = spaceRow?.c ?? 0;

    return c.json(
      {
        plan: org.plan,
        period_start: periodStart,
        period_end: periodEnd,
        tokens: metric(
          tokensUsed,
          entitlementNumber(entitlements, 'monthly_tokens_ingested'),
        ),
        queries: metric(
          queriesUsed,
          entitlementNumber(entitlements, 'monthly_search_queries'),
        ),
        spaces: metric(
          spacesUsed,
          entitlementNumber(entitlements, 'max_memory_spaces'),
        ),
        rate_limit_rpm: entitlementNumber(entitlements, 'rate_limit_rpm'),
        rate_limit_per_day: entitlementNumber(entitlements, 'rate_limit_per_day'),
      },
      200,
    );
  },
);
