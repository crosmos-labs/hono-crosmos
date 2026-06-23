import {
  organizationMembers,
  organizations,
  users,
  visibilityGrants,
  visibilityGroupMembers,
  visibilityGroups,
  type Database,
  type User,
  type VisibilityGrant,
  type VisibilityGroup,
  type VisibilityGroupMember,
} from '@crosmos/db';
import { and, asc, count, eq, inArray, ne, sql } from 'drizzle-orm';

export class VisibilityError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'not_found'
      | 'slug_taken'
      | 'duplicate_grant'
      | 'already_member'
      | 'self_grant'
      | 'grant_cycle'
      | 'user_not_in_org'
      | 'member_not_found',
  ) {
    super(message);
    this.name = 'VisibilityError';
  }
}

function sanitizeSlugPart(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export async function resolveVisibleUserIds(
  db: Database,
  input: { orgId: number; userId: number },
): Promise<number[]> {
  const rows = await db.execute<{ user_id: number }>(sql`
    WITH RECURSIVE my_groups AS (
      SELECT group_id
      FROM visibility_group_members
      WHERE org_id = ${input.orgId} AND user_id = ${input.userId}
    ),
    reachable AS (
      SELECT group_id FROM my_groups
      UNION
      SELECT g.subject_group_id
      FROM visibility_grants g
      JOIN reachable r ON g.viewer_group_id = r.group_id
      WHERE g.org_id = ${input.orgId}
    )
    SELECT DISTINCT m.user_id
    FROM visibility_group_members m
    JOIN reachable r ON m.group_id = r.group_id
    WHERE m.org_id = ${input.orgId}
  `);
  const visible = new Set<number>([input.userId]);
  for (const row of rows) visible.add(Number(row.user_id));
  return [...visible];
}

export async function resolveReadVisibility(
  db: Database,
  input: { orgId: number; userId: number },
): Promise<number[]> {
  const rows = await db
    .select({ visibilityEnabled: organizations.visibilityEnabled })
    .from(organizations)
    .where(eq(organizations.id, input.orgId))
    .limit(1);
  if (!rows[0]?.visibilityEnabled) return [input.userId];
  return resolveVisibleUserIds(db, input);
}

export async function createVisibilityGroup(
  db: Database,
  input: {
    orgId: number;
    name: string;
    slug?: string;
    createdByUserId?: number | null;
  },
): Promise<VisibilityGroup> {
  let slug = input.slug ? sanitizeSlugPart(input.slug) : sanitizeSlugPart(input.name).slice(0, 58);
  if (!slug) slug = 'group';

  if (input.slug) {
    const existing = await db
      .select({ id: visibilityGroups.id })
      .from(visibilityGroups)
      .where(and(eq(visibilityGroups.orgId, input.orgId), eq(visibilityGroups.slug, slug)))
      .limit(1);
    if (existing.length > 0) {
      throw new VisibilityError(`A visibility group with slug '${slug}' already exists`, 'slug_taken');
    }
  } else {
    const base = slug;
    let counter = 2;
    while (
      (
        await db
          .select({ id: visibilityGroups.id })
          .from(visibilityGroups)
          .where(and(eq(visibilityGroups.orgId, input.orgId), eq(visibilityGroups.slug, slug)))
          .limit(1)
      ).length > 0
    ) {
      slug = `${base}-${counter}`;
      counter++;
    }
  }

  const [row] = await db
    .insert(visibilityGroups)
    .values({
      orgId: input.orgId,
      name: input.name,
      slug,
      createdByUserId: input.createdByUserId ?? null,
    })
    .returning();
  if (!row) throw new Error('Failed to create visibility group');
  return row;
}

export async function listVisibilityGroups(
  db: Database,
  orgId: number,
  opts?: { limit?: number; offset?: number },
): Promise<VisibilityGroup[]> {
  return db
    .select()
    .from(visibilityGroups)
    .where(eq(visibilityGroups.orgId, orgId))
    .orderBy(asc(visibilityGroups.createdAt))
    .limit(opts?.limit ?? 200)
    .offset(opts?.offset ?? 0);
}

export async function countGroupMembers(
  db: Database,
  orgId: number,
): Promise<Map<number, number>> {
  const rows = await db
    .select({ groupId: visibilityGroupMembers.groupId, c: count() })
    .from(visibilityGroupMembers)
    .where(eq(visibilityGroupMembers.orgId, orgId))
    .groupBy(visibilityGroupMembers.groupId);
  return new Map(rows.map((r) => [r.groupId, r.c]));
}

export async function getVisibilityGroupByUuid(
  db: Database,
  input: { orgId: number; groupUuid: string },
): Promise<VisibilityGroup> {
  const rows = await db
    .select()
    .from(visibilityGroups)
    .where(and(eq(visibilityGroups.orgId, input.orgId), eq(visibilityGroups.uuid, input.groupUuid)))
    .limit(1);
  const group = rows[0];
  if (!group) throw new VisibilityError('Visibility group not found', 'not_found');
  return group;
}

export async function updateVisibilityGroup(
  db: Database,
  input: { orgId: number; groupId: number; name?: string; slug?: string },
): Promise<VisibilityGroup> {
  const currentRows = await db
    .select()
    .from(visibilityGroups)
    .where(and(eq(visibilityGroups.orgId, input.orgId), eq(visibilityGroups.id, input.groupId)))
    .limit(1);
  const current = currentRows[0];
  if (!current) throw new VisibilityError('Visibility group not found', 'not_found');

  const patch: Partial<typeof visibilityGroups.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (input.name !== undefined) patch.name = input.name;
  if (input.slug !== undefined) {
    const slug = sanitizeSlugPart(input.slug);
    if (slug !== current.slug) {
      const conflicts = await db
        .select({ id: visibilityGroups.id })
        .from(visibilityGroups)
        .where(and(
          eq(visibilityGroups.orgId, input.orgId),
          eq(visibilityGroups.slug, slug),
          ne(visibilityGroups.id, input.groupId),
        ))
        .limit(1);
      if (conflicts.length > 0) {
        throw new VisibilityError(`A visibility group with slug '${slug}' already exists`, 'slug_taken');
      }
    }
    patch.slug = slug;
  }

  const [row] = await db
    .update(visibilityGroups)
    .set(patch)
    .where(and(eq(visibilityGroups.orgId, input.orgId), eq(visibilityGroups.id, input.groupId)))
    .returning();
  if (!row) throw new VisibilityError('Visibility group not found', 'not_found');
  return row;
}

export async function deleteVisibilityGroup(
  db: Database,
  input: { orgId: number; groupId: number },
): Promise<void> {
  const rows = await db
    .delete(visibilityGroups)
    .where(and(eq(visibilityGroups.orgId, input.orgId), eq(visibilityGroups.id, input.groupId)))
    .returning({ id: visibilityGroups.id });
  if (rows.length === 0) throw new VisibilityError('Visibility group not found', 'not_found');
}

async function isOrgMember(
  db: Database,
  input: { orgId: number; userId: number },
): Promise<boolean> {
  const rows = await db
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, input.orgId), eq(organizationMembers.userId, input.userId)))
    .limit(1);
  return rows.length > 0;
}

export async function addGroupMember(
  db: Database,
  input: { orgId: number; groupId: number; userId: number },
): Promise<VisibilityGroupMember> {
  if (!(await isOrgMember(db, { orgId: input.orgId, userId: input.userId }))) {
    throw new VisibilityError('User is not a member of this organization', 'user_not_in_org');
  }
  const existing = await db
    .select({ id: visibilityGroupMembers.id })
    .from(visibilityGroupMembers)
    .where(and(
      eq(visibilityGroupMembers.groupId, input.groupId),
      eq(visibilityGroupMembers.userId, input.userId),
    ))
    .limit(1);
  if (existing.length > 0) {
    throw new VisibilityError('User is already a member of this group', 'already_member');
  }
  const [row] = await db
    .insert(visibilityGroupMembers)
    .values(input)
    .returning();
  if (!row) throw new Error('Failed to add visibility group member');
  return row;
}

export async function removeGroupMember(
  db: Database,
  input: { orgId: number; groupId: number; userId: number },
): Promise<void> {
  const rows = await db
    .delete(visibilityGroupMembers)
    .where(and(
      eq(visibilityGroupMembers.orgId, input.orgId),
      eq(visibilityGroupMembers.groupId, input.groupId),
      eq(visibilityGroupMembers.userId, input.userId),
    ))
    .returning({ id: visibilityGroupMembers.id });
  if (rows.length === 0) {
    throw new VisibilityError('User is not a member of this group', 'member_not_found');
  }
}

export async function removeUserFromAllGroups(
  db: Database,
  input: { orgId: number; userId: number },
): Promise<number> {
  const rows = await db
    .delete(visibilityGroupMembers)
    .where(and(eq(visibilityGroupMembers.orgId, input.orgId), eq(visibilityGroupMembers.userId, input.userId)))
    .returning({ id: visibilityGroupMembers.id });
  return rows.length;
}

export async function listGroupMembersWithUsers(
  db: Database,
  input: { orgId: number; groupId: number; limit?: number; offset?: number },
): Promise<Array<{ member: VisibilityGroupMember; user: User }>> {
  return db
    .select({ member: visibilityGroupMembers, user: users })
    .from(visibilityGroupMembers)
    .innerJoin(users, eq(users.id, visibilityGroupMembers.userId))
    .where(and(eq(visibilityGroupMembers.orgId, input.orgId), eq(visibilityGroupMembers.groupId, input.groupId)))
    .orderBy(asc(visibilityGroupMembers.createdAt))
    .limit(input.limit ?? 200)
    .offset(input.offset ?? 0);
}

async function groupReaches(
  db: Database,
  input: { orgId: number; startGroupId: number; targetGroupId: number },
): Promise<boolean> {
  const rows = await db.execute<{ exists: number }>(sql`
    WITH RECURSIVE reach AS (
      SELECT subject_group_id AS gid
      FROM visibility_grants
      WHERE org_id = ${input.orgId} AND viewer_group_id = ${input.startGroupId}
      UNION
      SELECT g.subject_group_id
      FROM visibility_grants g
      JOIN reach r ON g.viewer_group_id = r.gid
      WHERE g.org_id = ${input.orgId}
    )
    SELECT 1 AS exists FROM reach WHERE gid = ${input.targetGroupId} LIMIT 1
  `);
  return rows.length > 0;
}

export async function createGrant(
  db: Database,
  input: {
    orgId: number;
    viewerGroupId: number;
    subjectGroupId: number;
    createdByUserId?: number | null;
  },
): Promise<VisibilityGrant> {
  if (input.viewerGroupId === input.subjectGroupId) {
    throw new VisibilityError('A group cannot be granted visibility into itself', 'self_grant');
  }
  const existing = await db
    .select({ id: visibilityGrants.id })
    .from(visibilityGrants)
    .where(and(
      eq(visibilityGrants.orgId, input.orgId),
      eq(visibilityGrants.viewerGroupId, input.viewerGroupId),
      eq(visibilityGrants.subjectGroupId, input.subjectGroupId),
    ))
    .limit(1);
  if (existing.length > 0) throw new VisibilityError('That grant already exists', 'duplicate_grant');
  if (await groupReaches(db, {
    orgId: input.orgId,
    startGroupId: input.subjectGroupId,
    targetGroupId: input.viewerGroupId,
  })) {
    throw new VisibilityError('That grant would create a cycle in the visibility graph', 'grant_cycle');
  }
  const [row] = await db
    .insert(visibilityGrants)
    .values({
      orgId: input.orgId,
      viewerGroupId: input.viewerGroupId,
      subjectGroupId: input.subjectGroupId,
      createdByUserId: input.createdByUserId ?? null,
    })
    .returning();
  if (!row) throw new Error('Failed to create visibility grant');
  return row;
}

export async function listGrants(
  db: Database,
  orgId: number,
  opts?: { limit?: number; offset?: number },
): Promise<VisibilityGrant[]> {
  return db
    .select()
    .from(visibilityGrants)
    .where(eq(visibilityGrants.orgId, orgId))
    .orderBy(asc(visibilityGrants.createdAt))
    .limit(opts?.limit ?? 200)
    .offset(opts?.offset ?? 0);
}

async function closureForGroupMembers(
  db: Database,
  input: {
    orgId: number;
    viewerGroupId: number;
    extraGrant?: { viewerGroupId: number; subjectGroupId: number };
  },
): Promise<Set<number>> {
  const [members, grants] = await Promise.all([
    db
      .select({ userId: visibilityGroupMembers.userId })
      .from(visibilityGroupMembers)
      .where(and(
        eq(visibilityGroupMembers.orgId, input.orgId),
        eq(visibilityGroupMembers.groupId, input.viewerGroupId),
      )),
    db
      .select({
        viewerGroupId: visibilityGrants.viewerGroupId,
        subjectGroupId: visibilityGrants.subjectGroupId,
      })
      .from(visibilityGrants)
      .where(eq(visibilityGrants.orgId, input.orgId)),
  ]);
  if (input.extraGrant) grants.push(input.extraGrant);

  const adjacency = new Map<number, number[]>();
  for (const grant of grants) {
    const list = adjacency.get(grant.viewerGroupId);
    if (list) list.push(grant.subjectGroupId);
    else adjacency.set(grant.viewerGroupId, [grant.subjectGroupId]);
  }

  const reachable = new Set<number>([input.viewerGroupId]);
  const frontier = [input.viewerGroupId];
  while (frontier.length > 0) {
    const current = frontier.pop()!;
    for (const next of adjacency.get(current) ?? []) {
      if (reachable.has(next)) continue;
      reachable.add(next);
      frontier.push(next);
    }
  }

  const visible = new Set<number>(members.map((m) => m.userId));
  const memberRows = await db
    .select({ userId: visibilityGroupMembers.userId })
    .from(visibilityGroupMembers)
    .where(and(
      eq(visibilityGroupMembers.orgId, input.orgId),
      inArray(visibilityGroupMembers.groupId, [...reachable]),
    ));
  for (const row of memberRows) visible.add(row.userId);
  return visible;
}

export async function previewGrantImpact(
  db: Database,
  input: { orgId: number; viewerGroupId: number; subjectGroupId: number },
): Promise<number[]> {
  if (input.viewerGroupId === input.subjectGroupId) {
    throw new VisibilityError('A group cannot be granted visibility into itself', 'self_grant');
  }
  const existing = await db
    .select({ id: visibilityGrants.id })
    .from(visibilityGrants)
    .where(and(
      eq(visibilityGrants.orgId, input.orgId),
      eq(visibilityGrants.viewerGroupId, input.viewerGroupId),
      eq(visibilityGrants.subjectGroupId, input.subjectGroupId),
    ))
    .limit(1);
  if (existing.length > 0) throw new VisibilityError('That grant already exists', 'duplicate_grant');
  if (await groupReaches(db, {
    orgId: input.orgId,
    startGroupId: input.subjectGroupId,
    targetGroupId: input.viewerGroupId,
  })) {
    throw new VisibilityError('That grant would create a cycle in the visibility graph', 'grant_cycle');
  }

  const before = await closureForGroupMembers(db, {
    orgId: input.orgId,
    viewerGroupId: input.viewerGroupId,
  });
  const after = await closureForGroupMembers(db, {
    orgId: input.orgId,
    viewerGroupId: input.viewerGroupId,
    extraGrant: {
      viewerGroupId: input.viewerGroupId,
      subjectGroupId: input.subjectGroupId,
    },
  });
  return [...after].filter((userId) => !before.has(userId));
}

export async function getGrantByUuid(
  db: Database,
  input: { orgId: number; grantUuid: string },
): Promise<VisibilityGrant> {
  const rows = await db
    .select()
    .from(visibilityGrants)
    .where(and(eq(visibilityGrants.orgId, input.orgId), eq(visibilityGrants.uuid, input.grantUuid)))
    .limit(1);
  const grant = rows[0];
  if (!grant) throw new VisibilityError('Visibility grant not found', 'not_found');
  return grant;
}

export async function deleteGrant(
  db: Database,
  input: { orgId: number; grantId: number },
): Promise<void> {
  const rows = await db
    .delete(visibilityGrants)
    .where(and(eq(visibilityGrants.orgId, input.orgId), eq(visibilityGrants.id, input.grantId)))
    .returning({ id: visibilityGrants.id });
  if (rows.length === 0) throw new VisibilityError('Visibility grant not found', 'not_found');
}

export async function setVisibilityEnabled(
  db: Database,
  input: { orgId: number; enabled: boolean },
): Promise<boolean> {
  const [row] = await db
    .update(organizations)
    .set({ visibilityEnabled: input.enabled, updatedAt: new Date() })
    .where(eq(organizations.id, input.orgId))
    .returning({ visibilityEnabled: organizations.visibilityEnabled });
  if (!row) throw new VisibilityError('Organization not found', 'not_found');
  return row.visibilityEnabled;
}

export async function resolveUserByUuid(
  db: Database,
  userUuid: string,
): Promise<User | null> {
  const rows = await db.select().from(users).where(eq(users.uuid, userUuid)).limit(1);
  return rows[0] ?? null;
}

export async function loadUsersByIds(
  db: Database,
  userIds: readonly number[],
): Promise<Map<number, User>> {
  if (userIds.length === 0) return new Map();
  const rows = await db.select().from(users).where(inArray(users.id, [...userIds]));
  return new Map(rows.map((u) => [u.id, u]));
}
