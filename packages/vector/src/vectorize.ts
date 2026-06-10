import type {
  QueryOptions,
  UpsertItem,
  VectorCollection,
  VectorMatch,
  VectorScope,
  VectorStore,
} from './port';

/**
 * Cloudflare Vectorize-backed VectorStore. One index per collection
 * (`memories`, `entities`), accessed via Worker bindings. Tenant isolation uses
 * a **per-space namespace** (`space:{spaceId}`); `orgId`/`spaceId` are also
 * stored in metadata for debugging/backfill.
 *
 * Vectorize filters are implicit-AND and cannot express the memory visibility
 * OR (`visibility='org' OR owner ∈ set`), so `queryNearest` filters by
 * namespace only; the caller intersects results with the already-loaded visible
 * working set (see the semantic + graph signals). Cosine metric → returned
 * `score` is cosine similarity (higher = more similar), matching the port.
 *
 * `persistsInColumn` is false: vectors live in the index, not the PG column.
 */

// Vectorize: topK ≤ 100, or ≤ 50 when returning values/metadata. We never
// return values/metadata on query, so 100 is the cap.
const MAX_TOP_K = 100;
// getByIds is batched to stay within per-request limits.
const GET_BY_IDS_BATCH = 100;

export interface VectorizeStoreConfig {
  memoriesIndex: VectorizeIndex;
  entitiesIndex: VectorizeIndex;
}

export class VectorizeStore implements VectorStore {
  readonly persistsInColumn = false;

  constructor(private readonly config: VectorizeStoreConfig) {}

  private index(collection: VectorCollection): VectorizeIndex {
    return collection === 'memories'
      ? this.config.memoriesIndex
      : this.config.entitiesIndex;
  }

  async upsert(collection: VectorCollection, items: UpsertItem[]): Promise<void> {
    if (items.length === 0) return;
    await this.index(collection).upsert(
      items.map((it) => ({
        id: String(it.id),
        values: it.vector,
        namespace: namespaceFor(it.spaceId),
        metadata: { orgId: it.orgId, spaceId: it.spaceId },
      })),
    );
  }

  async queryNearest(
    collection: VectorCollection,
    vector: number[],
    scope: VectorScope,
    opts: QueryOptions,
  ): Promise<VectorMatch[]> {
    if (vector.length === 0 || opts.topK <= 0) return [];

    const res = await this.index(collection).query(vector, {
      topK: Math.min(opts.topK, MAX_TOP_K),
      namespace: namespaceFor(scope.spaceId),
      returnValues: false,
      returnMetadata: 'none',
    });

    const minScore = opts.minScore;
    const out: VectorMatch[] = [];
    for (const m of res.matches) {
      const score = m.score;
      if (minScore !== undefined && score < minScore) continue;
      out.push({ id: Number(m.id), score });
    }
    // Vectorize returns matches sorted by score desc already; keep that order.
    return out;
  }

  async fetchVectors(
    collection: VectorCollection,
    ids: number[],
  ): Promise<Map<number, number[]>> {
    const result = new Map<number, number[]>();
    if (ids.length === 0) return result;
    const index = this.index(collection);

    for (let i = 0; i < ids.length; i += GET_BY_IDS_BATCH) {
      const batch = ids.slice(i, i + GET_BY_IDS_BATCH).map(String);
      const records = await index.getByIds(batch);
      for (const rec of records) {
        result.set(Number(rec.id), Array.from(rec.values));
      }
    }
    return result;
  }

  async deleteByIds(collection: VectorCollection, ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await this.index(collection).deleteByIds(ids.map(String));
  }
}

function namespaceFor(spaceId: number): string {
  return `space:${spaceId}`;
}
