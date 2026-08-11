/**
 * In-memory `VectorStore` for tests and fixture capture.
 *
 * Models the EXTERNAL-index shape (`persistsInColumn: false`), matching
 * production's Qdrant rather than the pgvector adapter. That distinction is not
 * cosmetic: the flag selects real branches in the pipeline — the idempotency
 * purge only issues `deleteByIds` when vectors live outside Postgres, and the
 * memory insert writes a null `embedding` column. Capturing against
 * `PgVectorStore` would exercise a code path production never takes, and would
 * additionally collide with the `vector(1024)` column while production embeds
 * at 1536.
 *
 * Cosine similarity is computed exactly, so ANN approximation is removed as a
 * source of nondeterminism. That is the point: a baseline test should fail when
 * OUR ranking changes, not when a vector index reshuffles near-ties.
 */

export type VectorCollectionLike = 'memories' | 'entities';

interface StoredVector {
  id: number;
  vector: number[];
  orgId: number;
  spaceId: number;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export class MemoryVectorStore {
  readonly persistsInColumn = false;
  private readonly collections = new Map<string, Map<number, StoredVector>>();

  private col(collection: VectorCollectionLike): Map<number, StoredVector> {
    let c = this.collections.get(collection);
    if (!c) {
      c = new Map();
      this.collections.set(collection, c);
    }
    return c;
  }

  async upsert(
    collection: VectorCollectionLike,
    items: StoredVector[],
  ): Promise<void> {
    const c = this.col(collection);
    for (const item of items) c.set(item.id, { ...item });
  }

  async queryNearest(
    collection: VectorCollectionLike,
    vector: number[],
    scope: { orgId: number; spaceId: number },
    opts: { topK: number; minScore?: number },
  ): Promise<Array<{ id: number; score: number }>> {
    if (vector.length === 0 || opts.topK <= 0) return [];
    const matches: Array<{ id: number; score: number }> = [];
    for (const stored of this.col(collection).values()) {
      // Tenant scoping mirrors the real adapters' filter. Per-user visibility
      // is deliberately NOT applied: like Qdrant, this store cannot express it,
      // and Postgres remains the authoritative visibility gate.
      if (stored.orgId !== scope.orgId || stored.spaceId !== scope.spaceId) continue;
      const score = cosine(vector, stored.vector);
      if (opts.minScore !== undefined && score < opts.minScore) continue;
      matches.push({ id: stored.id, score });
    }
    // Score desc, then id asc so ties are broken deterministically rather than
    // by insertion order.
    matches.sort((a, b) => (b.score - a.score) || (a.id - b.id));
    return matches.slice(0, opts.topK);
  }

  async fetchVectors(
    collection: VectorCollectionLike,
    ids: number[],
  ): Promise<Map<number, number[]>> {
    const c = this.col(collection);
    const out = new Map<number, number[]>();
    for (const id of ids) {
      const stored = c.get(id);
      if (stored) out.set(id, stored.vector);
    }
    return out;
  }

  async deleteByIds(collection: VectorCollectionLike, ids: number[]): Promise<void> {
    const c = this.col(collection);
    for (const id of ids) c.delete(id);
  }

  /** Serialize for a fixture snapshot. */
  toJSON(): Record<string, StoredVector[]> {
    return Object.fromEntries(
      [...this.collections].map(([name, c]) => [name, [...c.values()]]),
    );
  }

  static fromJSON(data: Record<string, StoredVector[]>): MemoryVectorStore {
    const store = new MemoryVectorStore();
    for (const [name, items] of Object.entries(data)) {
      const c = store.col(name as VectorCollectionLike);
      for (const item of items) c.set(item.id, item);
    }
    return store;
  }

  get size(): number {
    let n = 0;
    for (const c of this.collections.values()) n += c.size;
    return n;
  }
}
