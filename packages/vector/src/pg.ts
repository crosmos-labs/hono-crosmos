import { type Database, entities, memories } from '@crosmos/db';
import {
  and,
  cosineDistance,
  eq,
  inArray,
  isNotNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type {
  QueryOptions,
  UpsertItem,
  VectorCollection,
  VectorMatch,
  VectorScope,
  VectorStore,
} from './port';

/**
 * pgvector-backed VectorStore. Wraps the existing HNSW cosine queries against
 * the `embedding` columns on `memories` / `entities` — this is the original
 * (pre-Vectorize) behaviour, kept selectable via `VECTOR_STORE=pg` so we can
 * revert. Vectors are written by the normal row inserts, so `upsert` is a no-op
 * and `persistsInColumn` is true.
 *
 * Score is cosine similarity (`1 - cosineDistance`), matching the port contract.
 */
export class PgVectorStore implements VectorStore {
  readonly persistsInColumn = true;

  constructor(private readonly db: Database) {}

  async upsert(_collection: VectorCollection, _items: UpsertItem[]): Promise<void> {
    // No-op: the row insert in ingestion already writes the `embedding` column.
  }

  async queryNearest(
    collection: VectorCollection,
    vector: number[],
    scope: VectorScope,
    opts: QueryOptions,
  ): Promise<VectorMatch[]> {
    if (vector.length === 0 || opts.topK <= 0) return [];

    const table = collection === 'memories' ? memories : entities;
    // Parenthesize the distance: Postgres `-` binds tighter than pgvector's
    // `<=>`, so `1.0 - embedding <=> $1` would misparse.
    const distance = cosineDistance(table.embedding, vector);

    const rows = await this.db
      .select({ id: table.id, score: sql<number>`1.0 - (${distance})` })
      .from(table)
      .where(and(this.scopeClause(collection, scope), isNotNull(table.embedding)))
      .orderBy(distance) // ascending distance = descending similarity
      .limit(opts.topK);

    const minScore = opts.minScore;
    const out: VectorMatch[] = [];
    for (const row of rows) {
      const score = Number(row.score);
      // Rows are similarity-ordered, so the first below-threshold row means all
      // remaining ones are too — truncate (matches the old semantic.py break).
      if (minScore !== undefined && score < minScore) break;
      out.push({ id: row.id, score });
    }
    return out;
  }

  async fetchVectors(
    collection: VectorCollection,
    ids: number[],
  ): Promise<Map<number, number[]>> {
    const result = new Map<number, number[]>();
    if (ids.length === 0) return result;
    const table = collection === 'memories' ? memories : entities;

    const rows = await this.db
      .select({ id: table.id, embedding: table.embedding })
      .from(table)
      .where(and(inArray(table.id, ids), isNotNull(table.embedding)));

    for (const row of rows) {
      if (row.embedding) result.set(row.id, row.embedding);
    }
    return result;
  }

  async deleteByIds(_collection: VectorCollection, _ids: number[]): Promise<void> {
    // No-op: vectors live on the row, so deleting the row (cascade) removes them.
  }

  /**
   * org + space, plus per-user visibility for `memories`. Mirrors
   * `apps/api/src/lib/scope.ts` (`scopeMemories` / `scopeEntities`); kept inline
   * so this package has no dependency on app code.
   */
  private scopeClause(collection: VectorCollection, scope: VectorScope): SQL {
    if (collection === 'entities') {
      return and(eq(entities.orgId, scope.orgId), eq(entities.spaceId, scope.spaceId))!;
    }
    const conds: SQL[] = [
      eq(memories.orgId, scope.orgId),
      eq(memories.spaceId, scope.spaceId),
    ];
    if (scope.visibleUserIds != null) {
      if (scope.visibleUserIds.length === 0) {
        conds.push(sql`false`);
      } else {
        conds.push(
          or(
            eq(memories.visibility, 'org'),
            inArray(memories.ownerUserId, [...scope.visibleUserIds]),
          )!,
        );
      }
    }
    return and(...conds)!;
  }
}
