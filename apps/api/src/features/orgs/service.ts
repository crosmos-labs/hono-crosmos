import {
  organizationMembers,
  organizations,
  type Organization,
  type OrganizationMember,
} from '@crosmos/db';
import type { Database } from '@crosmos/db';
import { tokenHex } from '../../lib/crypto';
import { and, count, desc, eq, inArray, ne } from 'drizzle-orm';

export class SlugCollisionError extends Error {
  constructor(name: string) {
    super(`Could not generate unique slug for name='${name}'`);
    this.name = 'SlugCollisionError';
  }
}

export class OrganizationNotFoundError extends Error {
  constructor(detail: string = 'Organization not found') {
    super(detail);
    this.name = 'OrganizationNotFoundError';
  }
}

function sanitizeSlugPart(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function slugExists(db: Database, slug: string): Promise<boolean> {
  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, slug))
    .limit(1);
  return rows.length > 0;
}

export async function generateUniqueSlug(
  db: Database,
  name: string,
  maxRetries = 5,
): Promise<string> {
  const base = sanitizeSlugPart(name).slice(0, 58) || 'org';
  if (!(await slugExists(db, base))) return base;
  for (let i = 0; i < maxRetries; i++) {
    const suffix = tokenHex(3); // 6 hex chars
    const slug = `${base}-${suffix}`;
    if (!(await slugExists(db, slug))) return slug;
  }
  throw new SlugCollisionError(name);
}

export async function getOrganizationById(
  db: Database,
  orgId: number,
): Promise<Organization | null> {
  const rows = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getOrganizationByIdOrThrow(
  db: Database,
  orgId: number,
): Promise<Organization> {
  const org = await getOrganizationById(db, orgId);
  if (!org) throw new OrganizationNotFoundError(`Organization ${orgId} not found`);
  return org;
}

export async function getOrganizationByUuid(
  db: Database,
  orgUuid: string,
): Promise<Organization | null> {
  const rows = await db
    .select()
    .from(organizations)
    .where(eq(organizations.uuid, orgUuid))
    .limit(1);
  return rows[0] ?? null;
}

export async function resolveOrgIdFromUuid(
  db: Database,
  orgUuid: string,
): Promise<number | null> {
  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.uuid, orgUuid))
    .limit(1);
  return rows[0]?.id ?? null;
}

export interface OrgMembershipRow {
  orgId: number;
  role: 'owner' | 'admin' | 'member';
  joinedAt: Date;
}

export async function getOrgMembershipsForUser(
  db: Database,
  userId: number,
): Promise<OrgMembershipRow[]> {
  return db
    .select({
      orgId: organizationMembers.orgId,
      role: organizationMembers.role,
      joinedAt: organizationMembers.joinedAt,
    })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, userId))
    .orderBy(organizationMembers.joinedAt);
}

export async function getOrganizationsByIds(
  db: Database,
  orgIds: number[],
  limit: number,
): Promise<Organization[]> {
  if (orgIds.length === 0) return [];
  return db
    .select()
    .from(organizations)
    .where(inArray(organizations.id, orgIds))
    .orderBy(desc(organizations.createdAt))
    .limit(limit);
}

export async function countMembers(
  db: Database,
  orgId: number,
): Promise<number> {
  const rows = await db
    .select({ c: count() })
    .from(organizationMembers)
    .where(eq(organizationMembers.orgId, orgId));
  return rows[0]?.c ?? 0;
}

export interface UpdateOrgInput {
  name?: string | null;
  slug?: string | null;
  billingEmail?: string | null;
}

export async function updateOrganization(
  db: Database,
  orgId: number,
  input: UpdateOrgInput,
): Promise<Organization> {
  const target = await getOrganizationByIdOrThrow(db, orgId);

  // Slug uniqueness (mirrors what api-routes.md documents as the 409 case).
  // Python relies on the DB constraint; we proactively translate to a
  // typed error so the route handler can return 409 cleanly.
  if (input.slug != null && input.slug !== target.slug) {
    const conflicts = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.slug, input.slug), ne(organizations.id, orgId)))
      .limit(1);
    if (conflicts.length > 0) {
      throw new SlugCollisionError(input.slug);
    }
  }

  const patch: Partial<typeof organizations.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (input.name != null) patch.name = input.name;
  if (input.slug != null) patch.slug = input.slug;
  if (input.billingEmail !== undefined) patch.billingEmail = input.billingEmail;

  const [row] = await db
    .update(organizations)
    .set(patch)
    .where(eq(organizations.id, orgId))
    .returning();
  if (!row) throw new OrganizationNotFoundError();
  return row;
}

export async function createPersonalOrg(
  db: Database,
  input: { userId: number; userName: string; userEmail: string | null },
): Promise<{ org: Organization; member: OrganizationMember }> {
  const slug = await generateUniqueSlug(db, input.userName);
  const [org] = await db
    .insert(organizations)
    .values({
      slug,
      name: input.userName,
      plan: 'free',
      isPersonal: true,
      billingEmail: input.userEmail,
      createdByUserId: input.userId,
    })
    .returning();
  if (!org) throw new Error('Failed to create personal org');

  const [member] = await db
    .insert(organizationMembers)
    .values({
      orgId: org.id,
      userId: input.userId,
      role: 'owner',
    })
    .returning();
  if (!member) throw new Error('Failed to create membership');

  return { org, member };
}
