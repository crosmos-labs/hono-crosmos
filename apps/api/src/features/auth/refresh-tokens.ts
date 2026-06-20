import { revokedRefreshTokens } from '@crosmos/db';
import type { Database } from '@crosmos/db';
import { eq } from 'drizzle-orm';

export async function isRefreshTokenRevoked(
  db: Database,
  jti: string,
): Promise<boolean> {
  const rows = await db
    .select({ jti: revokedRefreshTokens.jti })
    .from(revokedRefreshTokens)
    .where(eq(revokedRefreshTokens.jti, jti))
    .limit(1);
  return rows.length > 0;
}

export async function revokeRefreshToken(
  db: Database,
  input: { jti: string; userId: number; expiresAt: Date },
): Promise<void> {
  await db
    .insert(revokedRefreshTokens)
    .values({
      jti: input.jti,
      userId: input.userId,
      expiresAt: input.expiresAt,
    })
    .onConflictDoNothing({ target: revokedRefreshTokens.jti });
}

/**
 * Atomically revoke a refresh token IF it has not already been revoked.
 *
 * Revocation is modelled as presence of the `jti` in `revoked_refresh_tokens`,
 * whose primary key is `jti`. We insert-on-conflict-do-nothing and inspect the
 * RETURNING rows: a returned row means THIS call performed the revocation (the
 * token was active); zero rows means the row already existed (the token was
 * already used/revoked → reuse). The PK conflict makes this a single atomic,
 * race-free check-and-set — two concurrent `/refresh` calls with the same token
 * cannot both observe an active token.
 *
 * @returns `true` if this call revoked an active token, `false` if it was
 *          already revoked (reuse detected).
 */
export async function revokeRefreshTokenIfActive(
  db: Database,
  input: { jti: string; userId: number; expiresAt: Date },
): Promise<boolean> {
  const rows = await db
    .insert(revokedRefreshTokens)
    .values({
      jti: input.jti,
      userId: input.userId,
      expiresAt: input.expiresAt,
    })
    .onConflictDoNothing({ target: revokedRefreshTokens.jti })
    .returning({ jti: revokedRefreshTokens.jti });
  return rows.length > 0;
}
