import { describe, expect, it } from 'bun:test';
import {
  apiKeyCacheKey,
  entitlementCacheKey,
  invalidateApiKeyCacheHash,
  invalidateEntitlementCache,
} from '../src/api-key-cache';

describe('API key cache invalidation', () => {
  it('uses the same namespaced key in every worker', async () => {
    const deleted: string[] = [];
    await invalidateApiKeyCacheHash({
      async delete(key) { deleted.push(key); },
    }, 'abc123');

    expect(apiKeyCacheKey('abc123')).toBe('apikey:abc123');
    expect(deleted).toEqual(['apikey:abc123']);
  });

  it('shares the entitlement invalidation key with the admin plane', async () => {
    const deleted: string[] = [];
    await invalidateEntitlementCache({
      async delete(key) { deleted.push(key); },
    }, 42);

    expect(entitlementCacheKey(42)).toBe('gate:ent:42');
    expect(deleted).toEqual(['gate:ent:42']);
  });
});
