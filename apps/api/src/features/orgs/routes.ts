import {
  EntitlementsResponseSchema,
  MemberListResponseSchema,
  MemberResponseSchema,
  OrganizationListResponseSchema,
  OrganizationSchema,
  OrganizationSummarySchema,
  UpdateMemberRoleSchema,
  UpdateOrganizationSchema,
} from './schemas';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { and, count, eq } from 'drizzle-orm';
import { organizationMembers, users } from '@crosmos/db';
import type { HonoEnv } from '../../bindings';
import { getDb } from '../../db';
import { requireAuth } from '../auth/middleware';
import { requirePrincipal, requireRole } from '../auth/principal';
import { removeUserFromAllGroups } from '../visibility/service';
import { getEntitlements, getMonthlyUsage } from './entitlements';
import { getMembership } from './memberships';
import {
  countMembers,
  getOrganizationByIdOrThrow,
  getOrganizationByUuid,
  getOrgMembershipsForUser,
  getOrganizationsByIds,
  resolveOrgIdFromUuid,
  SlugCollisionError,
  updateOrganization,
} from './service';

export const orgRoutes = new OpenAPIHono<HonoEnv>();

const ErrorBody = z.object({ detail: z.string() }).openapi('OrgErrorBody');
const SlugConflictBody = z
  .object({
    detail: z.object({
      error: z.literal('slug_taken'),
      message: z.string(),
    }),
  })
  .openapi('OrgSlugConflictBody');

const errorResponses = {
  401: {
    description: 'Unauthorized',
    content: { 'application/json': { schema: ErrorBody } },
  },
  404: {
    description: 'Not found',
    content: { 'application/json': { schema: ErrorBody } },
  },
};

function orgToSummaryRow(
  org: Awaited<ReturnType<typeof getOrganizationByIdOrThrow>>,
  memberCount: number,
  role: 'owner' | 'admin' | 'member',
) {
  return {
    id: org.uuid,
    slug: org.slug,
    name: org.name,
    plan: org.plan,
    billing_email: org.billingEmail,
    created_at: org.createdAt.toISOString(),
    updated_at: org.updatedAt.toISOString(),
    member_count: memberCount,
    your_role: role,
  };
}

function orgToShallow(org: Awaited<ReturnType<typeof getOrganizationByIdOrThrow>>) {
  return {
    id: org.uuid,
    slug: org.slug,
    name: org.name,
    plan: org.plan,
    billing_email: org.billingEmail,
    created_at: org.createdAt.toISOString(),
    updated_at: org.updatedAt.toISOString(),
  };
}

function assertActiveOrg(orgId: number, activeOrgId: number | undefined) {
  if (orgId !== activeOrgId) {
    throw new HTTPException(404, { message: 'Organization not found' });
  }
}

async function countOwners(db: ReturnType<typeof getDb>, orgId: number): Promise<number> {
  const rows = await db
    .select({ c: count() })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.role, 'owner')));
  return rows[0]?.c ?? 0;
}

async function loadMember(db: ReturnType<typeof getDb>, orgId: number, userUuid: string) {
  const rows = await db
    .select({ member: organizationMembers, user: users })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(and(eq(organizationMembers.orgId, orgId), eq(users.uuid, userUuid)))
    .limit(1);
  return rows[0] ?? null;
}

function memberToResponse(row: {
  member: typeof organizationMembers.$inferSelect;
  user: typeof users.$inferSelect;
}) {
  return {
    user_id: row.user.uuid,
    email: row.user.email,
    name: row.user.name,
    role: row.member.role,
    joined_at: row.member.joinedAt.toISOString(),
  };
}

// GET /api/v1/orgs — list user's orgs
orgRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['organizations'],
    summary: "List the caller's organizations",
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth] as const,
    request: {
      query: z.object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
      }),
    },
    responses: {
      200: {
        description: 'Orgs the user is a member of',
        content: { 'application/json': { schema: OrganizationListResponseSchema } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const { limit } = c.req.valid('query');
    const db = getDb(c);

    const memberships = await getOrgMembershipsForUser(db, c.var.userId!);
    if (memberships.length === 0) {
      return c.json({ orgs: [], next_cursor: null }, 200);
    }

    const orgIds = memberships.map((m) => m.orgId);
    // limit+1 to detect has_more (mirrors Python)
    const orgs = await getOrganizationsByIds(db, orgIds, limit + 1);
    const hasMore = orgs.length > limit;
    const visible = hasMore ? orgs.slice(0, limit) : orgs;

    const roleMap = new Map(memberships.map((m) => [m.orgId, m.role] as const));
    const rows = await Promise.all(
      visible.map(async (org) => {
        const mc = await countMembers(db, org.id);
        const role = roleMap.get(org.id) ?? 'member';
        return orgToSummaryRow(org, mc, role);
      }),
    );

    const cursor = hasMore && rows.length > 0 ? rows[rows.length - 1]!.id : null;
    return c.json({ orgs: rows, next_cursor: cursor }, 200);
  },
);

// GET /api/v1/orgs/{org_uuid}/members
orgRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/{org_uuid}/members',
    tags: ['organizations'],
    summary: 'List organization members',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requirePrincipal] as const,
    request: {
      params: z.object({ org_uuid: z.string().uuid() }),
    },
    responses: {
      200: {
        description: 'Members',
        content: { 'application/json': { schema: MemberListResponseSchema } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const { org_uuid } = c.req.valid('param');
    const db = getDb(c);
    const orgId = await resolveOrgIdFromUuid(db, org_uuid);
    if (orgId == null) {
      throw new HTTPException(404, { message: 'Organization not found' });
    }
    assertActiveOrg(orgId, c.var.activeOrgId);

    const rows = await db
      .select({ member: organizationMembers, user: users })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(eq(organizationMembers.orgId, orgId))
      .orderBy(organizationMembers.joinedAt);

    return c.json(
      { members: rows.map(memberToResponse), next_cursor: null },
      200,
    );
  },
);

// PATCH /api/v1/orgs/{org_uuid}/members/{user_uuid}
orgRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/{org_uuid}/members/{user_uuid}',
    tags: ['organizations'],
    summary: 'Update organization member role',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requireRole('owner', 'admin')] as const,
    request: {
      params: z.object({
        org_uuid: z.string().uuid(),
        user_uuid: z.string().uuid(),
      }),
      body: {
        content: { 'application/json': { schema: UpdateMemberRoleSchema } },
      },
    },
    responses: {
      200: {
        description: 'Updated member',
        content: { 'application/json': { schema: MemberResponseSchema } },
      },
      403: {
        description: 'Insufficient role',
        content: { 'application/json': { schema: ErrorBody } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const { org_uuid, user_uuid } = c.req.valid('param');
    const { role } = c.req.valid('json');
    const db = getDb(c);
    const orgId = await resolveOrgIdFromUuid(db, org_uuid);
    if (orgId == null) {
      throw new HTTPException(404, { message: 'Organization not found' });
    }
    assertActiveOrg(orgId, c.var.activeOrgId);

    const target = await loadMember(db, orgId, user_uuid);
    if (!target) {
      throw new HTTPException(404, { message: 'Member not found' });
    }
    if (target.member.role === 'owner') {
      const owners = await countOwners(db, orgId);
      if (owners <= 1) {
        throw new HTTPException(400, { message: 'last_owner' });
      }
    }

    await db
      .update(organizationMembers)
      .set({ role, updatedAt: new Date() })
      .where(eq(organizationMembers.id, target.member.id));

    const updated = await loadMember(db, orgId, user_uuid);
    if (!updated) {
      throw new HTTPException(404, { message: 'Member not found' });
    }
    return c.json(memberToResponse(updated), 200);
  },
);

// DELETE /api/v1/orgs/{org_uuid}/members/{user_uuid}
orgRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/{org_uuid}/members/{user_uuid}',
    tags: ['organizations'],
    summary: 'Remove organization member',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requirePrincipal] as const,
    request: {
      params: z.object({
        org_uuid: z.string().uuid(),
        user_uuid: z.string().uuid(),
      }),
    },
    responses: {
      204: { description: 'Removed' },
      403: {
        description: 'Insufficient role',
        content: { 'application/json': { schema: ErrorBody } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const { org_uuid, user_uuid } = c.req.valid('param');
    const db = getDb(c);
    const orgId = await resolveOrgIdFromUuid(db, org_uuid);
    if (orgId == null) {
      throw new HTTPException(404, { message: 'Organization not found' });
    }
    assertActiveOrg(orgId, c.var.activeOrgId);

    const target = await loadMember(db, orgId, user_uuid);
    if (!target) {
      throw new HTTPException(404, { message: 'Member not found' });
    }
    const isSelf = target.user.id === c.var.userId;
    if (!isSelf && c.var.orgRole !== 'owner' && c.var.orgRole !== 'admin') {
      throw new HTTPException(403, { message: 'insufficient_role' });
    }
    if (target.member.role === 'owner') {
      const owners = await countOwners(db, orgId);
      if (owners <= 1) {
        throw new HTTPException(400, { message: 'last_owner' });
      }
    }

    await db
      .delete(organizationMembers)
      .where(eq(organizationMembers.id, target.member.id));
    await removeUserFromAllGroups(db, { orgId, userId: target.user.id });
    return c.body(null, 204);
  },
);

// GET /api/v1/orgs/{org_uuid} — detail
orgRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/{org_uuid}',
    tags: ['organizations'],
    summary: 'Get organization detail',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth] as const,
    request: {
      params: z.object({ org_uuid: z.string().uuid() }),
    },
    responses: {
      200: {
        description: 'Org detail',
        content: { 'application/json': { schema: OrganizationSummarySchema } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const { org_uuid } = c.req.valid('param');
    const db = getDb(c);

    const org = await getOrganizationByUuid(db, org_uuid);
    if (!org) {
      // 404 (mirrors Python — don't leak existence)
      throw new HTTPException(404, { message: 'Organization not found' });
    }
    const member = await getMembership(db, org.id, c.var.userId!);
    if (!member) {
      throw new HTTPException(404, { message: 'Organization not found' });
    }
    const mc = await countMembers(db, org.id);
    return c.json(orgToSummaryRow(org, mc, member.role), 200);
  },
);

// PATCH /api/v1/orgs/{org_uuid} — update (owner/admin only)
orgRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/{org_uuid}',
    tags: ['organizations'],
    summary: 'Update organization (owner/admin only)',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requireRole('owner', 'admin')] as const,
    request: {
      params: z.object({ org_uuid: z.string().uuid() }),
      body: { content: { 'application/json': { schema: UpdateOrganizationSchema } } },
    },
    responses: {
      200: {
        description: 'Updated',
        content: { 'application/json': { schema: OrganizationSchema } },
      },
      403: {
        description: 'Insufficient role',
        content: { 'application/json': { schema: ErrorBody } },
      },
      409: {
        description: 'Slug already taken',
        content: { 'application/json': { schema: SlugConflictBody } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const { org_uuid } = c.req.valid('param');
    const body = c.req.valid('json');
    const db = getDb(c);

    const orgId = await resolveOrgIdFromUuid(db, org_uuid);
    if (orgId == null) {
      throw new HTTPException(404, { message: 'Organization not found' });
    }
    // requireRole already verified membership in c.var.activeOrgId. The
    // path uuid must match — otherwise an owner of org A could PATCH org B.
    // (Python doesn't check this; we add it because in multi-org it'd be a bug.
    // In MVP the user has exactly one org so this is a no-op safety net.)
    if (orgId !== c.var.activeOrgId) {
      throw new HTTPException(404, { message: 'Organization not found' });
    }

    try {
      const updated = await updateOrganization(db, orgId, {
        name: body.name ?? null,
        slug: body.slug ?? null,
        billingEmail: body.billing_email === undefined ? undefined : body.billing_email,
      });
      return c.json(orgToShallow(updated), 200);
    } catch (err) {
      if (err instanceof SlugCollisionError) {
        return c.json(
          { detail: { error: 'slug_taken' as const, message: err.message } },
          409,
        );
      }
      throw err;
    }
  },
);

// GET /api/v1/orgs/{org_uuid}/entitlements
orgRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/{org_uuid}/entitlements',
    tags: ['organizations'],
    summary: "Get organization entitlements + this month's usage",
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requirePrincipal] as const,
    request: {
      params: z.object({ org_uuid: z.string().uuid() }),
    },
    responses: {
      200: {
        description: 'Entitlements',
        content: { 'application/json': { schema: EntitlementsResponseSchema } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const { org_uuid } = c.req.valid('param');
    const db = getDb(c);

    const orgId = await resolveOrgIdFromUuid(db, org_uuid);
    if (orgId == null) {
      throw new HTTPException(404, { message: 'Organization not found' });
    }
    // Same protection as PATCH (Python only checks principal.org_id membership).
    if (orgId !== c.var.activeOrgId) {
      throw new HTTPException(404, { message: 'Organization not found' });
    }

    const org = await getOrganizationByIdOrThrow(db, orgId);
    const ent = await getEntitlements(db, orgId);
    const tokens = await getMonthlyUsage(db, orgId, 'monthly_tokens_ingested');
    const queries = await getMonthlyUsage(db, orgId, 'monthly_search_queries');

    return c.json(
      {
        plan: org.plan,
        entitlements: ent,
        usage_this_month: {
          tokens_ingested: tokens,
          search_queries: queries,
        },
      },
      200,
    );
  },
);
