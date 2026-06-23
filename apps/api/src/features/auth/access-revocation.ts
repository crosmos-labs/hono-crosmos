import { getCacheStore, type CacheStoreEnv } from '../../integrations/cache';

/**
 * Access-token denylist, keyed by the token's `jti`.
 *
 * Access tokens are stateless JWTs (no per-request DB lookup beyond the user
 * row), so to revoke one *before* it expires we record its `jti` in the shared
 * KV cache with a TTL equal to the token's remaining lifetime. Once the token
 * would have expired anyway, the entry self-evicts — the denylist never grows
 * unbounded. Reads are edge-cached (~ms), so the per-request check the auth
 * middleware performs is cheap.
 *
 * This is paired with a short access-token TTL (see jwt.ts): the TTL bounds the
 * worst case if a revocation write is ever lost; the denylist makes explicit
 * logout/kill-session effective immediately.
 */
const REVOKED_PREFIX = 'revjwt:';

function key(jti: string): string {
  return `${REVOKED_PREFIX}${jti}`;
}

export async function revokeAccessToken(
  env: CacheStoreEnv,
  jti: string,
  expiresAt: Date,
): Promise<void> {
  // Keep the tombstone only until the token would expire on its own. Floor at a
  // few seconds so a near-expiry token still gets a usable TTL.
  const ttlSeconds = Math.max(
    5,
    Math.ceil((expiresAt.getTime() - Date.now()) / 1000),
  );
  await getCacheStore(env).putJson(
    key(jti),
    { revoked: true },
    { expirationTtlSeconds: ttlSeconds },
  );
}

export async function isAccessTokenRevoked(
  env: CacheStoreEnv,
  jti: string,
): Promise<boolean> {
  const entry = await getCacheStore(env).getJson<{ revoked: boolean }>(key(jti));
  return entry?.revoked === true;
}
