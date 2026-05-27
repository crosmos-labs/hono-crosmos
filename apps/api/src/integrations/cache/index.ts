import { CloudflareKvCacheStore } from './cloudflare';
import { MemoryCacheStore } from './memory';
import type { CacheStore } from './port';

export type { CachePutOptions, CacheStore } from './port';

const memoryFallback = new MemoryCacheStore();

export interface CacheStoreEnv {
  API_KEY_CACHE?: KVNamespace;
}

export function getCacheStore(env: CacheStoreEnv): CacheStore {
  if (env.API_KEY_CACHE) return new CloudflareKvCacheStore(env.API_KEY_CACHE);
  return memoryFallback;
}
