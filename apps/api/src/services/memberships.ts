import { organizationMembers, organizations } from '@crosmos/db';
import type { Database } from '@crosmos/db';
import { and, asc, eq } from 'drizzle-orm';

export interface MembershipRow {
  memberId: number;
  orgId: number;
  orgUuid: string;
  role: 'owner' | 'admin' | 'member';
}

export async function getMembership(
  db: Database,
  orgId: number,
  userId: number,
): Promise<MembershipRow | null> {
  const rows = await db
    .select({
      memberId: organizationMembers.id,
      orgId: organizationMembers.orgId,
      orgUuid: organizations.uuid,
      role: organizationMembers.role,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function getEarliestMembershipForUser(
  db: Database,
  userId: number,
): Promise<MembershipRow | null> {
  const rows = await db
    .select({
      memberId: organizationMembers.id,
      orgId: organizationMembers.orgId,
      orgUuid: organizations.uuid,
      role: organizationMembers.role,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
    .where(eq(organizationMembers.userId, userId))
    .orderBy(asc(organizationMembers.joinedAt), asc(organizationMembers.id))
    .limit(1);
  return rows[0] ?? null;
}
