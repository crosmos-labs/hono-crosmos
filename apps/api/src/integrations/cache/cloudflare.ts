import type { CachePutOptions, CacheStore } from './port';

export class CloudflareKvCacheStore implements CacheStore {
  constructor(private readonly kv: KVNamespace) {}

  async getJson<T>(key: string): Promise<T | null> {
    return (await this.kv.get(key, 'json')) as T | null;
  }

  async putJson<T>(
    key: string,
    value: T,
    opts: CachePutOptions = {},
  ): Promise<void> {
    const putOptions =
      opts.expirationTtlSeconds === undefined
        ? undefined
        : { expirationTtl: opts.expirationTtlSeconds };

    await this.kv.put(key, JSON.stringify(value), putOptions);
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key);
  }
}
