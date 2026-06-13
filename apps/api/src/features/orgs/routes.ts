import {
  AcceptInviteResponseSchema,
  AcceptInviteSchema,
  CreateInviteSchema,
  EntitlementsResponseSchema,
  InviteListResponseSchema,
  InvitePreviewResponseSchema,
  InviteResponseSchema,
  MemberListQuerySchema,
  MemberListResponseSchema,
  MemberResponseSchema,
  OrganizationListResponseSchema,
  OrganizationSchema,
  OrganizationSummarySchema,
  UpdateMemberRoleSchema,
  UpdateOrganizationSchema,
} from './schemas';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { createApiApp } from '../../lib/openapi';
import { HTTPException } from 'hono/http-exception';
import { createLogger } from '@crosmos/observability';
import { and, count, desc, eq, gt, isNull, or } from 'drizzle-orm';
import { organizationInvites, organizationMembers, organizations, users } from '@crosmos/db';
import type { HonoEnv } from '../../bindings';
import { getDb } from '../../db';
import { getEmailSender } from '../../integrations/email';
import {
  enforcePlanRateLimit,
  getRateLimiter,
  RateLimitError,
} from '../../integrations/rate-limit';
import { sha256Hex, tokenUrlSafe } from '../../lib/crypto';
import { apiError, AppError } from '../../lib/errors';
import { invalidateMembership } from '../../lib/gate-cache';
import { waitUntilLogged } from '../../lib/runtime';
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

export const orgRoutes = createApiApp();

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

// Opaque keyset cursor over (joinedAt, userId). base64url of `${epochMs}:${userId}`.
interface MemberCursor {
  joinedAtMs: number;
  userId: number;
}

function encodeMemberCursor(c: MemberCursor): string {
  // Payload is ASCII (`${epochMs}:${userId}`), so btoa is safe. URL-safe base64
  // to match the token encoding used elsewhere (lib/crypto.ts).
  return btoa(`${c.joinedAtMs}:${c.userId}`)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeMemberCursor(raw: string): MemberCursor | null {
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = atob(b64);
    const sep = decoded.indexOf(':');
    if (sep < 0) return null;
    const joinedAtMs = Number(decoded.slice(0, sep));
    const userId = Number(decoded.slice(sep + 1));
    if (!Number.isFinite(joinedAtMs) || !Number.isInteger(userId)) return null;
    return { joinedAtMs, userId };
  } catch {
    return null;
  }
}

function inviteStatus(invite: typeof organizationInvites.$inferSelect) {
  if (invite.acceptedAt) return 'accepted' as const;
  if (invite.expiresAt.getTime() < Date.now()) return 'expired' as const;
  return 'pending' as const;
}

async function loadInviteByToken(db: ReturnType<typeof getDb>, token: string) {
  const tokenHash = await sha256Hex(token);
  const rows = await db
    .select({ invite: organizationInvites, org: organizations, inviter: users })
    .from(organizationInvites)
    .innerJoin(organizations, eq(organizations.id, organizationInvites.orgId))
    .innerJoin(users, eq(users.id, organizationInvites.invitedBy))
    .where(eq(organizationInvites.tokenHash, tokenHash))
    .limit(1);
  return rows[0] ?? null;
}

function inviteToResponse(row: {
  invite: typeof organizationInvites.$inferSelect;
  inviter: typeof users.$inferSelect;
}) {
  return {
    id: row.invite.uuid,
    email: row.invite.email,
    role: row.invite.role as 'admin' | 'member',
    invited_by: row.inviter.uuid,
    expires_at: row.invite.expiresAt.toISOString(),
    status: inviteStatus(row.invite),
  };
}

function inviteAcceptUrl(c: Parameters<typeof getDb>[0], token: string) {
  const base = c.env.INVITE_ACCEPT_URL ?? `${c.env.APP_BASE_URL}/invites/accept`;
  const url = new URL(base);
  url.searchParams.set('token', token);
  return url.toString();
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

// POST /api/v1/orgs/invites/accept
orgRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/invites/accept',
    tags: ['organizations'],
    summary: 'Accept organization invite',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth] as const,
    request: {
      body: { content: { 'application/json': { schema: AcceptInviteSchema } } },
    },
    responses: {
      200: {
        description: 'Invite accepted',
        content: { 'application/json': { schema: AcceptInviteResponseSchema } },
      },
      400: {
        description: 'Invite rejected',
        content: { 'application/json': { schema: ErrorBody } },
      },
      409: {
        description: 'Invite already accepted or user already member',
        content: { 'application/json': { schema: ErrorBody } },
      },
      410: {
        description: 'Invite expired',
        content: { 'application/json': { schema: ErrorBody } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const { token } = c.req.valid('json');
    const db = getDb(c);
    const row = await loadInviteByToken(db, token);
    if (!row) throw new HTTPException(404, { message: 'Invite not found' });
    const status = inviteStatus(row.invite);
    if (status === 'expired') throw new HTTPException(410, { message: 'Invite is expired' });
    if (status === 'accepted') throw new HTTPException(409, { message: 'Invite is accepted' });
    if (row.invite.email.trim().toLowerCase() !== c.var.userEmail!.trim().toLowerCase()) {
      throw new HTTPException(400, { message: 'This invite was issued to a different email address' });
    }
    const existing = await getMembership(db, row.invite.orgId, c.var.userId!);
    if (existing) {
      throw new HTTPException(409, { message: 'User is already a member of organization' });
    }

    await db.insert(organizationMembers).values({
      orgId: row.invite.orgId,
      userId: c.var.userId!,
      role: row.invite.role,
      invitedByUserId: row.invite.invitedBy,
    });
    await db
      .update(organizationInvites)
      .set({ acceptedAt: new Date() })
      .where(eq(organizationInvites.id, row.invite.id));

    return c.json(
      {
        org: orgToShallow(row.org),
        role: row.invite.role as 'admin' | 'member',
      },
      200,
    );
  },
);

// GET /api/v1/orgs/invites/preview
orgRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/invites/preview',
    tags: ['organizations'],
    summary: 'Preview organization invite',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth] as const,
    request: {
      query: z.object({ token: z.string().min(20).max(128) }),
    },
    responses: {
      200: {
        description: 'Invite preview',
        content: { 'application/json': { schema: InvitePreviewResponseSchema } },
      },
      409: {
        description: 'Invite already accepted',
        content: { 'application/json': { schema: ErrorBody } },
      },
      410: {
        description: 'Invite expired',
        content: { 'application/json': { schema: ErrorBody } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const { token } = c.req.valid('query');
    const row = await loadInviteByToken(getDb(c), token);
    if (!row) throw new HTTPException(404, { message: 'Invite not found' });
    const status = inviteStatus(row.invite);
    if (status === 'expired') throw new HTTPException(410, { message: 'Invite is expired' });
    if (status === 'accepted') throw new HTTPException(409, { message: 'Invite is accepted' });
    return c.json(
      {
        org_name: row.org.name,
        inviter_name: row.inviter.name,
        role: row.invite.role as 'admin' | 'member',
        email: row.invite.email,
        expires_at: row.invite.expiresAt.toISOString(),
      },
      200,
    );
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
      query: MemberListQuerySchema,
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
    const { limit, cursor } = c.req.valid('query');
    const db = getDb(c);
    const orgId = await resolveOrgIdFromUuid(db, org_uuid);
    if (orgId == null) {
      throw new HTTPException(404, { message: 'Organization not found' });
    }
    assertActiveOrg(orgId, c.var.activeOrgId);

    // Keyset pagination on (joinedAt, userId). A bad cursor is rejected rather
    // than silently ignored so clients notice corrupted tokens.
    let after: MemberCursor | null = null;
    if (cursor != null) {
      after = decodeMemberCursor(cursor);
      if (after == null) {
        throw new HTTPException(400, { message: 'Invalid cursor' });
      }
    }

    const keyset = after
      ? or(
          gt(organizationMembers.joinedAt, new Date(after.joinedAtMs)),
          and(
            eq(organizationMembers.joinedAt, new Date(after.joinedAtMs)),
            gt(organizationMembers.userId, after.userId),
          ),
        )
      : undefined;

    // Fetch limit+1 to detect whether another page exists.
    const rows = await db
      .select({ member: organizationMembers, user: users })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(eq(organizationMembers.orgId, orgId), keyset))
      .orderBy(organizationMembers.joinedAt, organizationMembers.userId)
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeMemberCursor({
            joinedAtMs: last.member.joinedAt.getTime(),
            userId: last.member.userId,
          })
        : null;

    return c.json(
      { members: page.map(memberToResponse), next_cursor: nextCursor },
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
    // Only an owner may modify another owner — an admin must not demote an owner.
    if (target.member.role === 'owner' && c.var.orgRole !== 'owner') {
      throw new AppError(403, 'insufficient_role', 'Only an owner can modify an owner');
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

    // Membership role is cached in KV (gate:member) for 60s; invalidate so a
    // demoted admin loses admin powers immediately instead of after the TTL.
    await invalidateMembership(c.env, orgId, target.user.id);

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
    // Only an owner may remove another owner — an admin must not remove an
    // owner. (Self-removal is allowed: a self-removing owner is already owner.)
    if (!isSelf && target.member.role === 'owner' && c.var.orgRole !== 'owner') {
      throw new AppError(403, 'insufficient_role', 'Only an owner can remove an owner');
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
    // Invalidate the 60s KV membership cache so a removed user loses access
    // immediately instead of retaining it until the TTL expires.
    await invalidateMembership(c.env, orgId, target.user.id);
    return c.body(null, 204);
  },
);

// POST /api/v1/orgs/{org_uuid}/invites
orgRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/{org_uuid}/invites',
    tags: ['organizations'],
    summary: 'Create organization invite',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requireRole('owner', 'admin')] as const,
    request: {
      params: z.object({ org_uuid: z.string().uuid() }),
      body: { content: { 'application/json': { schema: CreateInviteSchema } } },
    },
    responses: {
      201: {
        description: 'Invite created',
        content: { 'application/json': { schema: InviteResponseSchema } },
      },
      409: {
        description: 'Pending invite already exists',
        content: { 'application/json': { schema: ErrorBody } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const { org_uuid } = c.req.valid('param');
    const body = c.req.valid('json');
    const db = getDb(c);
    const orgId = await resolveOrgIdFromUuid(db, org_uuid);
    if (orgId == null) throw new HTTPException(404, { message: 'Organization not found' });
    assertActiveOrg(orgId, c.var.activeOrgId);
    const org = await getOrganizationByIdOrThrow(db, orgId);

    // Per-org rate limit so a compromised/abusive admin can't mail-bomb arbitrary
    // addresses (Resend cost + reputation). Reuses the org's plan RPM/daily caps.
    const limiter = getRateLimiter(c.env);
    try {
      await enforcePlanRateLimit(db, limiter, orgId);
    } catch (err) {
      if (err instanceof RateLimitError) {
        // Thrown (not returned) so it bypasses the OpenAPI response-type
        // checking; the global onError renders the canonical envelope.
        throw new HTTPException(429, {
          res: apiError(c, 429, 'Rate limit exceeded', {
            code: 'rate_limited',
            headers: { 'Retry-After': String(err.retryAfterSeconds) },
          }),
        });
      }
      throw err;
    }

    const normalizedEmail = body.email.trim().toLowerCase();
    const [existing] = await db
      .select()
      .from(organizationInvites)
      .where(
        and(
          eq(organizationInvites.orgId, orgId),
          eq(organizationInvites.email, normalizedEmail),
          isNull(organizationInvites.acceptedAt),
        ),
      )
      .limit(1);
    if (existing && inviteStatus(existing) === 'pending') {
      throw new HTTPException(409, { message: 'A pending invite already exists' });
    }
    if (existing && inviteStatus(existing) === 'expired') {
      await db.delete(organizationInvites).where(eq(organizationInvites.id, existing.id));
    }

    const rawToken = tokenUrlSafe(32);
    const [invite] = await db
      .insert(organizationInvites)
      .values({
        orgId,
        email: normalizedEmail,
        role: body.role,
        tokenHash: await sha256Hex(rawToken),
        invitedBy: c.var.userId!,
      })
      .returning();
    if (!invite) throw new Error('Failed to create invite');

    // Fire the invite email best-effort, but LOG failures — a silently dropped
    // email previously left the invite committed with no trace of the failure.
    waitUntilLogged(
      c,
      createLogger({
        service: 'api',
        environment: c.env.ENVIRONMENT,
        base: { org_id: orgId },
      }),
      'orgs.invite_email_failed',
      getEmailSender(c.env).sendInvite({
        to: invite.email,
        orgName: org.name,
        inviterName: c.var.userName!,
        role: invite.role,
        acceptUrl: inviteAcceptUrl(c, rawToken),
        expiresAt: invite.expiresAt,
      }),
      { org_id: orgId },
    );

    return c.json(
      inviteToResponse({
        invite,
        inviter: {
          id: c.var.userId!,
          uuid: c.var.userUuid!,
          email: c.var.userEmail!,
          name: c.var.userName!,
          oauthProvider: null,
          oauthProviderId: null,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      }),
      201,
    );
  },
);

// GET /api/v1/orgs/{org_uuid}/invites
orgRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/{org_uuid}/invites',
    tags: ['organizations'],
    summary: 'List organization invites',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requireRole('owner', 'admin')] as const,
    request: {
      params: z.object({ org_uuid: z.string().uuid() }),
    },
    responses: {
      200: {
        description: 'Pending invites',
        content: { 'application/json': { schema: InviteListResponseSchema } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const { org_uuid } = c.req.valid('param');
    const db = getDb(c);
    const orgId = await resolveOrgIdFromUuid(db, org_uuid);
    if (orgId == null) throw new HTTPException(404, { message: 'Organization not found' });
    assertActiveOrg(orgId, c.var.activeOrgId);

    const rows = await db
      .select({ invite: organizationInvites, inviter: users })
      .from(organizationInvites)
      .innerJoin(users, eq(users.id, organizationInvites.invitedBy))
      .where(and(eq(organizationInvites.orgId, orgId), isNull(organizationInvites.acceptedAt)))
      .orderBy(desc(organizationInvites.createdAt));

    return c.json({ invites: rows.map(inviteToResponse) }, 200);
  },
);

// DELETE /api/v1/orgs/{org_uuid}/invites/{invite_uuid}
orgRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/{org_uuid}/invites/{invite_uuid}',
    tags: ['organizations'],
    summary: 'Revoke organization invite',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requireRole('owner', 'admin')] as const,
    request: {
      params: z.object({
        org_uuid: z.string().uuid(),
        invite_uuid: z.string().uuid(),
      }),
    },
    responses: {
      204: { description: 'Revoked' },
      ...errorResponses,
    },
  }),
  async (c) => {
    const { org_uuid, invite_uuid } = c.req.valid('param');
    const db = getDb(c);
    const orgId = await resolveOrgIdFromUuid(db, org_uuid);
    if (orgId == null) throw new HTTPException(404, { message: 'Organization not found' });
    assertActiveOrg(orgId, c.var.activeOrgId);
    const deleted = await db
      .delete(organizationInvites)
      .where(
        and(
          eq(organizationInvites.orgId, orgId),
          eq(organizationInvites.uuid, invite_uuid),
        ),
      )
      .returning({ id: organizationInvites.id });
    if (deleted.length === 0) {
      throw new HTTPException(404, { message: 'Invite not found' });
    }
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
