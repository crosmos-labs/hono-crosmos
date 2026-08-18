import { createRoute, z } from '@hono/zod-openapi';
import { createApiApp } from '../../lib/openapi';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { HonoEnv } from '../../bindings';
import { getDb } from '../../db';
import { PaginationQuerySchema } from '../../lib/zod-common';
import { requireAuth } from '../auth/middleware';
import { requireRole } from '../auth/principal';
import { getMembership } from '../orgs/memberships';
import { getOrganizationByIdOrThrow, resolveOrgIdFromUuid } from '../orgs/service';
import {
  CreateGrantSchema,
  CreateGroupSchema,
  GrantImpactSchema,
  GrantListSchema,
  GrantSchema,
  GroupListSchema,
  GroupMemberListSchema,
  GroupSchema,
  UpdateGroupSchema,
  UpdateVisibilitySettingsSchema,
  VisibilityPreviewSchema,
  VisibilitySettingsSchema,
} from './schemas';
import {
  VisibilityError,
  addGroupMember,
  countGroupMembers,
  createGrant,
  createVisibilityGroup,
  deleteGrant,
  deleteVisibilityGroup,
  getGrantByUuid,
  getVisibilityGroupByUuid,
  listGrants,
  listGroupMembersWithUsers,
  listVisibilityGroups,
  loadUsersByIds,
  previewGrantImpact,
  removeGroupMember,
  resolveUserByUuid,
  resolveVisibleUserIds,
  setVisibilityEnabled,
  updateVisibilityGroup,
} from './service';

export const visibilityRoutes = createApiApp();

const ErrorBody = z.object({ detail: z.unknown() }).openapi('VisibilityErrorBody');

const errorResponses = {
  400: { description: 'Bad request', content: { 'application/json': { schema: ErrorBody } } },
  401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorBody } } },
  403: { description: 'Forbidden', content: { 'application/json': { schema: ErrorBody } } },
  404: { description: 'Not found', content: { 'application/json': { schema: ErrorBody } } },
  409: { description: 'Conflict', content: { 'application/json': { schema: ErrorBody } } },
};

function mapVisibilityError(err: VisibilityError): HTTPException {
  const statusByCode: Record<VisibilityError['code'], number> = {
    not_found: 404,
    slug_taken: 409,
    duplicate_grant: 409,
    already_member: 409,
    self_grant: 400,
    grant_cycle: 409,
    user_not_in_org: 400,
    member_not_found: 404,
  };
  return new HTTPException(statusByCode[err.code] as 400 | 404 | 409, {
    res: new Response(
      JSON.stringify({ detail: { error: err.code, message: err.message } }),
      { status: statusByCode[err.code], headers: { 'Content-Type': 'application/json' } },
    ),
  });
}

async function scopedOrgId(
  c: Context<HonoEnv>,
  orgUuid: string,
): Promise<number> {
  const db = getDb(c);
  const orgId = await resolveOrgIdFromUuid(db, orgUuid);
  if (orgId == null || orgId !== c.var.activeOrgId) {
    throw new HTTPException(404, { message: 'Organization not found' });
  }
  return orgId;
}

function groupToResponse(
  group: Awaited<ReturnType<typeof getVisibilityGroupByUuid>>,
  memberCount: number,
) {
  return {
    id: group.uuid,
    slug: group.slug,
    name: group.name,
    member_count: memberCount,
    created_at: group.createdAt.toISOString(),
    updated_at: group.updatedAt.toISOString(),
  };
}

async function grantResponseFromGroups(
  db: ReturnType<typeof getDb>,
  grant: Awaited<ReturnType<typeof getGrantByUuid>>,
) {
  const groups = await listVisibilityGroups(db, grant.orgId);
  const byId = new Map(groups.map((g) => [g.id, g]));
  const viewer = byId.get(grant.viewerGroupId);
  const subject = byId.get(grant.subjectGroupId);
  if (!viewer || !subject) {
    throw new HTTPException(404, { message: 'Visibility grant not found' });
  }
  return {
    id: grant.uuid,
    viewer_group_id: viewer.uuid,
    viewer_group_slug: viewer.slug,
    subject_group_id: subject.uuid,
    subject_group_slug: subject.slug,
    created_at: grant.createdAt.toISOString(),
  };
}

visibilityRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/{org_uuid}/visibility/groups',
    tags: ['visibility'],
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requireRole('owner', 'admin')] as const,
    request: {
      params: z.object({ org_uuid: z.string().uuid() }),
      body: { content: { 'application/json': { schema: CreateGroupSchema } } },
    },
    responses: {
      201: { description: 'Created', content: { 'application/json': { schema: GroupSchema } } },
      ...errorResponses,
    },
  }),
  async (c) => {
    const db = getDb(c);
    const orgId = await scopedOrgId(c, c.req.valid('param').org_uuid);
    try {
      const group = await createVisibilityGroup(db, {
        orgId,
        name: c.req.valid('json').name,
        slug: c.req.valid('json').slug,
        createdByUserId: c.var.userId!,
      });
      return c.json(groupToResponse(group, 0), 201);
    } catch (err) {
      if (err instanceof VisibilityError) throw mapVisibilityError(err);
      throw err;
    }
  },
);

visibilityRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/{org_uuid}/visibility/groups',
    tags: ['visibility'],
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requireRole('owner', 'admin')] as const,
    request: {
      params: z.object({ org_uuid: z.string().uuid() }),
      query: PaginationQuerySchema,
    },
    responses: {
      200: { description: 'Groups', content: { 'application/json': { schema: GroupListSchema } } },
      ...errorResponses,
    },
  }),
  async (c) => {
    const db = getDb(c);
    const orgId = await scopedOrgId(c, c.req.valid('param').org_uuid);
    const { limit, offset } = c.req.valid('query');
    const [groups, counts] = await Promise.all([
      listVisibilityGroups(db, orgId, { limit, offset }),
      countGroupMembers(db, orgId),
    ]);
    return c.json({ groups: groups.map((g) => groupToResponse(g, counts.get(g.id) ?? 0)) }, 200);
  },
);

visibilityRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/{org_uuid}/visibility/groups/{group_uuid}',
    tags: ['visibility'],
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requireRole('owner', 'admin')] as const,
    request: {
      params: z.object({ org_uuid: z.string().uuid(), group_uuid: z.string().uuid() }),
      body: { content: { 'application/json': { schema: UpdateGroupSchema } } },
    },
    responses: {
      200: { description: 'Updated', content: { 'application/json': { schema: GroupSchema } } },
      ...errorResponses,
    },
  }),
  async (c) => {
    const db = getDb(c);
    const { org_uuid, group_uuid } = c.req.valid('param');
    const orgId = await scopedOrgId(c, org_uuid);
    try {
      const group = await getVisibilityGroupByUuid(db, { orgId, groupUuid: group_uuid });
      const updated = await updateVisibilityGroup(db, {
        orgId,
        groupId: group.id,
        ...c.req.valid('json'),
      });
      const counts = await countGroupMembers(db, orgId);
      return c.json(groupToResponse(updated, counts.get(updated.id) ?? 0), 200);
    } catch (err) {
      if (err instanceof VisibilityError) throw mapVisibilityError(err);
      throw err;
    }
  },
);

visibilityRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/{org_uuid}/visibility/groups/{group_uuid}',
    tags: ['visibility'],
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requireRole('owner', 'admin')] as const,
    request: { params: z.object({ org_uuid: z.string().uuid(), group_uuid: z.string().uuid() }) },
    responses: { 204: { description: 'Deleted' }, ...errorResponses },
  }),
  async (c) => {
    const db = getDb(c);
    const { org_uuid, group_uuid } = c.req.valid('param');
    const orgId = await scopedOrgId(c, org_uuid);
    try {
      const group = await getVisibilityGroupByUuid(db, { orgId, groupUuid: group_uuid });
      await deleteVisibilityGroup(db, { orgId, groupId: group.id });
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof VisibilityError) throw mapVisibilityError(err);
      throw err;
    }
  },
);

visibilityRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/{org_uuid}/visibility/groups/{group_uuid}/members',
    tags: ['visibility'],
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requireRole('owner', 'admin')] as const,
    request: {
      params: z.object({ org_uuid: z.string().uuid(), group_uuid: z.string().uuid() }),
      query: PaginationQuerySchema,
    },
    responses: {
      200: { description: 'Members', content: { 'application/json': { schema: GroupMemberListSchema } } },
      ...errorResponses,
    },
  }),
  async (c) => {
    const db = getDb(c);
    const { org_uuid, group_uuid } = c.req.valid('param');
    const { limit, offset } = c.req.valid('query');
    const orgId = await scopedOrgId(c, org_uuid);
    const group = await getVisibilityGroupByUuid(db, { orgId, groupUuid: group_uuid });
    const members = await listGroupMembersWithUsers(db, { orgId, groupId: group.id, limit, offset });
    return c.json({
      members: members.map(({ user }) => ({
        user_id: user.uuid,
        email: user.email,
        name: user.name,
      })),
    }, 200);
  },
);

visibilityRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/{org_uuid}/visibility/groups/{group_uuid}/members/{user_uuid}',
    tags: ['visibility'],
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requireRole('owner', 'admin')] as const,
    request: { params: z.object({ org_uuid: z.string().uuid(), group_uuid: z.string().uuid(), user_uuid: z.string().uuid() }) },
    responses: { 204: { description: 'Added' }, ...errorResponses },
  }),
  async (c) => {
    const db = getDb(c);
    const { org_uuid, group_uuid, user_uuid } = c.req.valid('param');
    const orgId = await scopedOrgId(c, org_uuid);
    const group = await getVisibilityGroupByUuid(db, { orgId, groupUuid: group_uuid });
    const user = await resolveUserByUuid(db, user_uuid);
    if (!user) throw new HTTPException(404, { message: 'User not found' });
    try {
      await addGroupMember(db, { orgId, groupId: group.id, userId: user.id });
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof VisibilityError) throw mapVisibilityError(err);
      throw err;
    }
  },
);

visibilityRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/{org_uuid}/visibility/groups/{group_uuid}/members/{user_uuid}',
    tags: ['visibility'],
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requireRole('owner', 'admin')] as const,
    request: { params: z.object({ org_uuid: z.string().uuid(), group_uuid: z.string().uuid(), user_uuid: z.string().uuid() }) },
    responses: { 204: { description: 'Removed' }, ...errorResponses },
  }),
  async (c) => {
    const db = getDb(c);
    const { org_uuid, group_uuid, user_uuid } = c.req.valid('param');
    const orgId = await scopedOrgId(c, org_uuid);
    const group = await getVisibilityGroupByUuid(db, { orgId, groupUuid: group_uuid });
    const user = await resolveUserByUuid(db, user_uuid);
    if (!user) throw new HTTPException(404, { message: 'User not found' });
    try {
      await removeGroupMember(db, { orgId, groupId: group.id, userId: user.id });
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof VisibilityError) throw mapVisibilityError(err);
      throw err;
    }
  },
);

visibilityRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/{org_uuid}/visibility/grants',
    tags: ['visibility'],
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requireRole('owner', 'admin')] as const,
    request: {
      params: z.object({ org_uuid: z.string().uuid() }),
      body: { content: { 'application/json': { schema: CreateGrantSchema } } },
    },
    responses: {
      201: { description: 'Created', content: { 'application/json': { schema: GrantSchema } } },
      ...errorResponses,
    },
  }),
  async (c) => {
    const db = getDb(c);
    const orgId = await scopedOrgId(c, c.req.valid('param').org_uuid);
    const body = c.req.valid('json');
    const viewer = await getVisibilityGroupByUuid(db, { orgId, groupUuid: body.viewer_group_id });
    const subject = await getVisibilityGroupByUuid(db, { orgId, groupUuid: body.subject_group_id });
    try {
      const grant = await createGrant(db, {
        orgId,
        viewerGroupId: viewer.id,
        subjectGroupId: subject.id,
        createdByUserId: c.var.userId!,
      });
      return c.json(await grantResponseFromGroups(db, grant), 201);
    } catch (err) {
      if (err instanceof VisibilityError) throw mapVisibilityError(err);
      throw err;
    }
  },
);

visibilityRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/{org_uuid}/visibility/grants/preview',
    tags: ['visibility'],
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requireRole('owner', 'admin')] as const,
    request: {
      params: z.object({ org_uuid: z.string().uuid() }),
      body: { content: { 'application/json': { schema: CreateGrantSchema } } },
    },
    responses: {
      200: { description: 'Grant impact', content: { 'application/json': { schema: GrantImpactSchema } } },
      ...errorResponses,
    },
  }),
  async (c) => {
    const db = getDb(c);
    const orgId = await scopedOrgId(c, c.req.valid('param').org_uuid);
    const body = c.req.valid('json');
    const viewer = await getVisibilityGroupByUuid(db, { orgId, groupUuid: body.viewer_group_id });
    const subject = await getVisibilityGroupByUuid(db, { orgId, groupUuid: body.subject_group_id });
    try {
      const ids = await previewGrantImpact(db, {
        orgId,
        viewerGroupId: viewer.id,
        subjectGroupId: subject.id,
      });
      const users = await loadUsersByIds(db, ids);
      return c.json({
        viewer_group_id: body.viewer_group_id,
        subject_group_id: body.subject_group_id,
        newly_visible: ids.flatMap((id) => {
          const user = users.get(id);
          return user ? [{ user_id: user.uuid, email: user.email, name: user.name }] : [];
        }),
      }, 200);
    } catch (err) {
      if (err instanceof VisibilityError) throw mapVisibilityError(err);
      throw err;
    }
  },
);

visibilityRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/{org_uuid}/visibility/grants',
    tags: ['visibility'],
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requireRole('owner', 'admin')] as const,
    request: {
      params: z.object({ org_uuid: z.string().uuid() }),
      query: PaginationQuerySchema,
    },
    responses: {
      200: { description: 'Grants', content: { 'application/json': { schema: GrantListSchema } } },
      ...errorResponses,
    },
  }),
  async (c) => {
    const db = getDb(c);
    const orgId = await scopedOrgId(c, c.req.valid('param').org_uuid);
    const { limit, offset } = c.req.valid('query');
    const grants = await listGrants(db, orgId, { limit, offset });
    return c.json({ grants: await Promise.all(grants.map((g) => grantResponseFromGroups(db, g))) }, 200);
  },
);

visibilityRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/{org_uuid}/visibility/grants/{grant_uuid}',
    tags: ['visibility'],
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requireRole('owner', 'admin')] as const,
    request: { params: z.object({ org_uuid: z.string().uuid(), grant_uuid: z.string().uuid() }) },
    responses: { 204: { description: 'Deleted' }, ...errorResponses },
  }),
  async (c) => {
    const db = getDb(c);
    const { org_uuid, grant_uuid } = c.req.valid('param');
    const orgId = await scopedOrgId(c, org_uuid);
    try {
      const grant = await getGrantByUuid(db, { orgId, grantUuid: grant_uuid });
      await deleteGrant(db, { orgId, grantId: grant.id });
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof VisibilityError) throw mapVisibilityError(err);
      throw err;
    }
  },
);

visibilityRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/{org_uuid}/visibility/preview',
    tags: ['visibility'],
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requireRole('owner', 'admin')] as const,
    request: {
      params: z.object({ org_uuid: z.string().uuid() }),
      query: z.object({ user_id: z.string().uuid() }),
    },
    responses: {
      200: { description: 'Preview', content: { 'application/json': { schema: VisibilityPreviewSchema } } },
      ...errorResponses,
    },
  }),
  async (c) => {
    const db = getDb(c);
    const orgId = await scopedOrgId(c, c.req.valid('param').org_uuid);
    const user = await resolveUserByUuid(db, c.req.valid('query').user_id);
    if (!user || !(await getMembership(db, orgId, user.id))) {
      throw new HTTPException(404, { message: 'User not found' });
    }
    const [org, visibleIds] = await Promise.all([
      getOrganizationByIdOrThrow(db, orgId),
      resolveVisibleUserIds(db, { orgId, userId: user.id }),
    ]);
    const visibleUsers = await loadUsersByIds(db, visibleIds);
    return c.json({
      user_id: user.uuid,
      visibility_enabled: org.visibilityEnabled,
      visible_users: visibleIds.flatMap((id) => {
        const visibleUser = visibleUsers.get(id);
        return visibleUser
          ? [{ user_id: visibleUser.uuid, email: visibleUser.email, name: visibleUser.name }]
          : [];
      }),
    }, 200);
  },
);

visibilityRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/{org_uuid}/visibility/settings',
    tags: ['visibility'],
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requireRole('owner', 'admin')] as const,
    request: {
      params: z.object({ org_uuid: z.string().uuid() }),
      body: { content: { 'application/json': { schema: UpdateVisibilitySettingsSchema } } },
    },
    responses: {
      200: { description: 'Settings', content: { 'application/json': { schema: VisibilitySettingsSchema } } },
      ...errorResponses,
    },
  }),
  async (c) => {
    const db = getDb(c);
    const orgId = await scopedOrgId(c, c.req.valid('param').org_uuid);
    const visibilityEnabled = await setVisibilityEnabled(db, {
      orgId,
      enabled: c.req.valid('json').enabled,
    });
    return c.json({ visibility_enabled: visibilityEnabled }, 200);
  },
);
