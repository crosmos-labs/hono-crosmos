import type { CachePutOptions, CacheStore } from './port';

interface MemoryEntry {
  value: unknown;
  expiresAtMs: number | null;
}

export class MemoryCacheStore implements CacheStore {
  private readonly entries = new Map<string, MemoryEntry>();

  async getJson<T>(key: string): Promise<T | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async putJson<T>(
    key: string,
    value: T,
    opts: CachePutOptions = {},
  ): Promise<void> {
    this.entries.set(key, {
      value,
      expiresAtMs:
        opts.expirationTtlSeconds === undefined
          ? null
          : Date.now() + opts.expirationTtlSeconds * 1000,
    });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}
