import {
  organizationInvites,
  organizationMembers,
  organizations,
  users,
  type Database,
  type OrganizationInvite,
} from '@crosmos/db';
import { and, count, desc, eq, gt, isNull, or } from 'drizzle-orm';
import { sha256Hex } from '../../lib/crypto';

export async function countOwners(db: Database, orgId: number): Promise<number> {
  const rows = await db.select({ c: count() })
    .from(organizationMembers)
    .where(and(
      eq(organizationMembers.orgId, orgId),
      eq(organizationMembers.role, 'owner'),
    ));
  return rows[0]?.c ?? 0;
}

export async function loadMember(db: Database, orgId: number, userUuid: string) {
  const rows = await db.select({ member: organizationMembers, user: users })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(and(eq(organizationMembers.orgId, orgId), eq(users.uuid, userUuid)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listMembersPage(
  db: Database,
  orgId: number,
  after: { joinedAtMs: number; userId: number } | null,
  limit: number,
) {
  const keyset = after
    ? or(
        gt(organizationMembers.joinedAt, new Date(after.joinedAtMs)),
        and(
          eq(organizationMembers.joinedAt, new Date(after.joinedAtMs)),
          gt(organizationMembers.userId, after.userId),
        ),
      )
    : undefined;
  return db.select({ member: organizationMembers, user: users })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(and(eq(organizationMembers.orgId, orgId), keyset))
    .orderBy(organizationMembers.joinedAt, organizationMembers.userId)
    .limit(limit + 1);
}

export async function updateMemberRole(
  db: Database,
  memberId: number,
  role: 'admin' | 'member',
) {
  await db.update(organizationMembers)
    .set({ role, updatedAt: new Date() })
    .where(eq(organizationMembers.id, memberId));
}

export async function deleteMember(db: Database, memberId: number) {
  await db.delete(organizationMembers).where(eq(organizationMembers.id, memberId));
}

export function inviteStatus(invite: OrganizationInvite) {
  if (invite.acceptedAt) return 'accepted' as const;
  if (invite.expiresAt.getTime() < Date.now()) return 'expired' as const;
  return 'pending' as const;
}

export async function loadInviteByToken(db: Database, token: string) {
  const rows = await db.select({ invite: organizationInvites, org: organizations, inviter: users })
    .from(organizationInvites)
    .innerJoin(organizations, eq(organizations.id, organizationInvites.orgId))
    .innerJoin(users, eq(users.id, organizationInvites.invitedBy))
    .where(eq(organizationInvites.tokenHash, await sha256Hex(token)))
    .limit(1);
  return rows[0] ?? null;
}

export async function acceptInviteMembership(
  db: Database,
  invite: OrganizationInvite,
  userId: number,
) {
  await db.insert(organizationMembers).values({
    orgId: invite.orgId,
    userId,
    role: invite.role,
    invitedByUserId: invite.invitedBy,
  });
  await db.update(organizationInvites)
    .set({ acceptedAt: new Date() })
    .where(eq(organizationInvites.id, invite.id));
}

export async function findPendingInvite(
  db: Database,
  orgId: number,
  email: string,
) {
  const rows = await db.select()
    .from(organizationInvites)
    .where(and(
      eq(organizationInvites.orgId, orgId),
      eq(organizationInvites.email, email),
      isNull(organizationInvites.acceptedAt),
    ))
    .limit(1);
  return rows[0] ?? null;
}

export async function deleteInvite(db: Database, inviteId: number) {
  await db.delete(organizationInvites).where(eq(organizationInvites.id, inviteId));
}

export async function createOrganizationInvite(
  db: Database,
  input: {
    orgId: number;
    email: string;
    role: 'admin' | 'member';
    rawToken: string;
    invitedBy: number;
  },
) {
  const [invite] = await db.insert(organizationInvites).values({
    orgId: input.orgId,
    email: input.email,
    role: input.role,
    tokenHash: await sha256Hex(input.rawToken),
    invitedBy: input.invitedBy,
  }).returning();
  if (!invite) throw new Error('Failed to create invite');
  return invite;
}

export function listOrganizationInvites(
  db: Database,
  orgId: number,
  limit: number,
  offset: number,
) {
  return db.select({ invite: organizationInvites, inviter: users })
    .from(organizationInvites)
    .innerJoin(users, eq(users.id, organizationInvites.invitedBy))
    .where(and(
      eq(organizationInvites.orgId, orgId),
      isNull(organizationInvites.acceptedAt),
    ))
    .orderBy(desc(organizationInvites.createdAt))
    .limit(limit)
    .offset(offset);
}

export async function revokeOrganizationInvite(
  db: Database,
  orgId: number,
  inviteUuid: string,
) {
  const deleted = await db.delete(organizationInvites)
    .where(and(
      eq(organizationInvites.orgId, orgId),
      eq(organizationInvites.uuid, inviteUuid),
    ))
    .returning({ id: organizationInvites.id });
  return deleted.length > 0;
}
