import {
  organizationMembers,
  organizations,
  type Organization,
  type OrganizationMember,
} from '@crosmos/db';
import type { Database } from '@crosmos/db';
import { tokenHex } from '@crosmos/auth';
import { eq } from 'drizzle-orm';

export class SlugCollisionError extends Error {
  constructor(name: string) {
    super(`Could not generate unique slug for "${name}"`);
    this.name = 'SlugCollisionError';
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
