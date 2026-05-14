import type { Database, MemorySpace, Organization, User } from '@crosmos/db';
import { getUserByEmail, getUserByOauth, createUser } from './users';
import { users } from '@crosmos/db';
import { eq } from 'drizzle-orm';
import { createPersonalOrg } from './organizations';
import { createDefaultSpace } from './spaces';

export interface OauthSignupResult {
  user: User;
  isNewUser: boolean;
  org: Organization | null;
  defaultSpace: MemorySpace | null;
}

/**
 * Get-or-create the user identified by an OAuth identity.
 * Matches by (provider, provider_id) first, then by email.
 * For brand-new users, also creates a personal org + default memory space.
 */
export async function getOrCreateOauthUser(
  db: Database,
  input: {
    provider: string;
    providerUserId: string;
    email: string;
    name: string;
  },
): Promise<OauthSignupResult> {
  // 1) Exact OAuth identity match
  const existingByOauth = await getUserByOauth(db, input.provider, input.providerUserId);
  if (existingByOauth) {
    return { user: existingByOauth, isNewUser: false, org: null, defaultSpace: null };
  }

  // 2) Email match — link OAuth identity to existing account
  const existingByEmail = await getUserByEmail(db, input.email);
  if (existingByEmail) {
    const [linked] = await db
      .update(users)
      .set({
        oauthProvider: input.provider,
        oauthProviderId: input.providerUserId,
        updatedAt: new Date(),
      })
      .where(eq(users.id, existingByEmail.id))
      .returning();
    return { user: linked ?? existingByEmail, isNewUser: false, org: null, defaultSpace: null };
  }

  // 3) Brand-new user → also create personal org + default space
  const user = await createUser(db, {
    email: input.email,
    name: input.name,
    oauthProvider: input.provider,
    oauthProviderId: input.providerUserId,
  });
  const { org } = await createPersonalOrg(db, {
    userId: user.id,
    userName: user.name,
    userEmail: user.email,
  });
  const defaultSpace = await createDefaultSpace(db, {
    userId: user.id,
    orgId: org.id,
  });
  return { user, isNewUser: true, org, defaultSpace };
}
