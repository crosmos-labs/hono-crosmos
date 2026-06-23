import type { Database, MemorySpace, Organization, User } from '@crosmos/db';
import { getUserByEmail, getUserByOauth, createUser } from '../auth/users';
import { users } from '@crosmos/db';
import { eq } from 'drizzle-orm';
import { createPersonalOrg } from '../orgs/service';
import { createDefaultSpace } from '../spaces/service';
import { OAuthError } from './google';

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
 *
 * `emailVerified` MUST be true for the email-match auto-link path: linking an
 * OAuth identity to a pre-existing account purely because the asserted email
 * matches is an account-takeover vector unless the provider has proven the user
 * controls that mailbox. The Google adapter already rejects unverified tokens
 * upstream, so this is defense-in-depth that also guards any future provider.
 */
export async function getOrCreateOauthUser(
  db: Database,
  input: {
    provider: string;
    providerUserId: string;
    email: string;
    emailVerified: boolean;
    name: string;
  },
): Promise<OauthSignupResult> {
  // 1) Exact OAuth identity match
  const existingByOauth = await getUserByOauth(db, input.provider, input.providerUserId);
  if (existingByOauth) {
    return { user: existingByOauth, isNewUser: false, org: null, defaultSpace: null };
  }

  // 2) Email match — link OAuth identity to existing account. ONLY when the
  // provider verified the email; otherwise refuse to merge into an existing
  // account (takeover defense). A brand-new identity with an unverified email
  // and no existing account is handled by the create path below.
  const existingByEmail = await getUserByEmail(db, input.email);
  if (existingByEmail) {
    if (!input.emailVerified) {
      throw new OAuthError('Cannot link an unverified email to an existing account');
    }
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
