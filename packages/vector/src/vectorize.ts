import {
  VectorStoreError,
  type QueryOptions,
  type UpsertItem,
  type VectorCollection,
  type VectorMatch,
  type VectorScope,
  type VectorStore,
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
    try {
      await this.index(collection).upsert(
        items.map((it) => ({
          id: String(it.id),
          values: it.vector,
          namespace: namespaceFor(it.spaceId),
          metadata: { orgId: it.orgId, spaceId: it.spaceId },
        })),
      );
    } catch (err) {
      throw wrapVectorizeError('upsert', err);
    }
  }

  async queryNearest(
    collection: VectorCollection,
    vector: number[],
    scope: VectorScope,
    opts: QueryOptions,
  ): Promise<VectorMatch[]> {
    if (vector.length === 0 || opts.topK <= 0) return [];

    let res: Awaited<ReturnType<VectorizeIndex['query']>>;
    try {
      res = await this.index(collection).query(vector, {
        topK: Math.min(opts.topK, MAX_TOP_K),
        namespace: namespaceFor(scope.spaceId),
        returnValues: false,
        returnMetadata: 'none',
      });
    } catch (err) {
      throw wrapVectorizeError('query', err);
    }

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
      let records: Awaited<ReturnType<VectorizeIndex['getByIds']>>;
      try {
        records = await index.getByIds(batch);
      } catch (err) {
        throw wrapVectorizeError('getByIds', err);
      }
      for (const rec of records) {
        result.set(Number(rec.id), Array.from(rec.values));
      }
    }
    return result;
  }

  async deleteByIds(collection: VectorCollection, ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      await this.index(collection).deleteByIds(ids.map(String));
    } catch (err) {
      throw wrapVectorizeError('deleteByIds', err);
    }
  }
}

function namespaceFor(spaceId: number): string {
  return `space:${spaceId}`;
}

/**
 * Normalize a thrown Vectorize binding error into a {@link VectorStoreError} so
 * the ingestion consumer can branch on one error type across all backends.
 *
 * The Vectorize binding doesn't expose a reliable HTTP status on its errors, and
 * the documented prod failure mode under load is 429/503 (transient). So we
 * default to `retryable: true`: a write failure here re-queues the job rather
 * than terminally dropping the memories (which would leave PG rows with no
 * searchable vector forever). See `apps/ingestion/src/process-ingestion.ts`.
 */
function wrapVectorizeError(op: string, err: unknown): VectorStoreError {
  if (err instanceof VectorStoreError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new VectorStoreError(`Vectorize ${op} failed: ${message}`, {
    status: 503,
    retryable: true,
  });
}
