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
