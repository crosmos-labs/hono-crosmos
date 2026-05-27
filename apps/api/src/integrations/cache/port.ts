export interface CachePutOptions {
  expirationTtlSeconds?: number;
}

export interface CacheStore {
  getJson<T>(key: string): Promise<T | null>;
  putJson<T>(key: string, value: T, opts?: CachePutOptions): Promise<void>;
  delete(key: string): Promise<void>;
}
