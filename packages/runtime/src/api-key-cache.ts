export interface KeyCacheDeletePort {
  delete(key: string): Promise<void>;
}

export function apiKeyCacheKey(hash: string): string {
  return `apikey:${hash}`;
}

export function entitlementCacheKey(orgId: number): string {
  return `gate:ent:${orgId}`;
}

export async function invalidateEntitlementCache(
  cache: KeyCacheDeletePort,
  orgId: number,
): Promise<void> {
  await cache.delete(entitlementCacheKey(orgId));
}

/** Shared invalidation primitive used by both the public API and admin plane. */
export async function invalidateApiKeyCacheHash(
  cache: KeyCacheDeletePort,
  hash: string,
): Promise<void> {
  await cache.delete(apiKeyCacheKey(hash));
}
