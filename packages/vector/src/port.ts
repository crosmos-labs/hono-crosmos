/**
 * VectorStore port — the interface retrieval + ingestion use for approximate
 * nearest-neighbour (ANN) search and vector storage. Lets the vector DB be
 * swapped (Postgres/pgvector ↔ Cloudflare Vectorize) behind one interface.
 *
 * Implementations: `./pg.ts` (pgvector columns on `memories`/`entities`) and
 * `./vectorize.ts` (Cloudflare Vectorize indexes). Each app wires one from its
 * own env (`getVectorStore(env, db)`).
 *
 * Scores are **cosine similarity** in all implementations: higher = more
 * similar, 1.0 = identical. Callers' thresholds (e.g. `SEMANTIC_MIN_SCORE`)
 * compare against this, so adapters must normalize their backend's metric to
 * cosine similarity.
 */

/** Which logical collection a vector belongs to. */
export type VectorCollection = 'memories' | 'entities';

export interface VectorMatch {
  /** The integer row id (`memories.id` / `entities.id`). */
  id: number;
  /** Cosine similarity to the query vector, higher = more similar. */
  score: number;
}

/**
 * Tenant scope for a query. `orgId` + `spaceId` are always applied. For the
 * `memories` collection on the read path, `visibleUserIds` restricts results to
 * `visibility='org'` OR `owner_user_id ∈ visibleUserIds` — the pg adapter
 * applies this in-query; the Vectorize adapter cannot express the OR, so the
 * caller is responsible for intersecting results with the already-loaded
 * visible working set (see the semantic + graph signals). `null`/`undefined`
 * means no per-user visibility filter (system/ingestion paths).
 */
export interface VectorScope {
  orgId: number;
  spaceId: number;
  visibleUserIds?: readonly number[] | null;
}

export interface QueryOptions {
  /** Max results to return. */
  topK: number;
  /** Drop matches with cosine similarity below this. */
  minScore?: number;
}

export interface UpsertItem {
  id: number;
  vector: number[];
  orgId: number;
  spaceId: number;
}

export interface VectorStore {
  /**
   * Whether vectors are persisted in the backing Postgres `embedding` column.
   * `true` for the pg adapter (the row insert stores the vector, so `upsert` is
   * a no-op and `fetchVectors` reads the column); `false` for Vectorize (the
   * row's column stays null and vectors live in the index). Writers use this to
   * decide whether to put the vector on the row insert.
   */
  readonly persistsInColumn: boolean;

  /** Insert or replace vectors for a collection. */
  upsert(collection: VectorCollection, items: UpsertItem[]): Promise<void>;

  /**
   * ANN search: returns up to `topK` matches sorted by cosine similarity desc,
   * already filtered by `scope` and `minScore`. Empty query vector or no
   * matches → empty array.
   */
  queryNearest(
    collection: VectorCollection,
    vector: number[],
    scope: VectorScope,
    opts: QueryOptions,
  ): Promise<VectorMatch[]>;

  /**
   * Optional batched ANN search: run several query vectors against one
   * collection in a single backend call, returning one match list per input
   * vector (same order, same `scope`/`opts` applied to each). Adapters that
   * speak a remote API over HTTP (e.g. Qdrant) implement this to collapse N
   * per-vector round trips into one request — important under Cloudflare's
   * per-invocation subrequest cap, where each `fetch` counts. Callers must
   * fall back to looping `queryNearest` when this is undefined.
   */
  queryNearestBatch?(
    collection: VectorCollection,
    vectors: number[][],
    scope: VectorScope,
    opts: QueryOptions,
  ): Promise<VectorMatch[][]>;

  /**
   * Fetch raw vectors by id (used by MMR diversification). Missing ids are
   * simply absent from the returned map.
   */
  fetchVectors(
    collection: VectorCollection,
    ids: number[],
  ): Promise<Map<number, number[]>>;

  /** Remove vectors by id (e.g. when memories are physically deleted). */
  deleteByIds(collection: VectorCollection, ids: number[]): Promise<void>;
}
