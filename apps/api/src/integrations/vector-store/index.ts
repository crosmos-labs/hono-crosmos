import type { Database } from '@crosmos/db';
import { PgVectorStore, QdrantStore, VectorizeStore } from '@crosmos/vector';
import type { VectorStore } from '@crosmos/vector';
import type { Env } from '../../bindings';
import { getApiConfig } from '../../config';

export type { VectorStore } from '@crosmos/vector';

/**
 * Vector store for the retrieval read path, selected by `VECTOR_STORE`:
 *   - `vectorize` (default) — Cloudflare Vectorize indexes via bindings.
 *     Edge-native ANN. Vectors live in the index, not Postgres.
 *   - `qdrant` — Qdrant cloud cluster over REST. Vectors live in Qdrant.
 *   - `pg` — pgvector columns on `memories`/`entities` (original behaviour).
 *     Kept selectable for reversibility.
 */
export function getVectorStore(env: Env, db: Database): VectorStore {
  const config = getApiConfig(env).vectorStore;
  if (config.provider === 'pg') {
    return new PgVectorStore(db);
  }
  if (config.provider === 'qdrant') {
    return new QdrantStore({
      url: config.url,
      apiKey: config.apiKey,
      memoriesCollection: config.memoriesCollection,
      entitiesCollection: config.entitiesCollection,
    });
  }
  if (!env.MEMORIES_INDEX || !env.ENTITIES_INDEX) {
    throw new Error(
      'MEMORIES_INDEX/ENTITIES_INDEX bindings are required for VECTOR_STORE=vectorize',
    );
  }
  return new VectorizeStore({
    memoriesIndex: env.MEMORIES_INDEX,
    entitiesIndex: env.ENTITIES_INDEX,
  });
}

/**
 * Build a Qdrant-backed store from env. `QDRANT_URL`/`QDRANT_API_KEY` are
 * required; collection names default to `crosmos-memories`/`crosmos-entities`
 * and can be overridden per env.
 */
export function buildQdrantStore(env: Env): VectorStore {
  const config = getApiConfig(env).vectorStore;
  if (config.provider !== 'qdrant') {
    throw new Error('buildQdrantStore requires VECTOR_STORE=qdrant');
  }
  return new QdrantStore({
    url: config.url,
    apiKey: config.apiKey,
    memoriesCollection: config.memoriesCollection,
    entitiesCollection: config.entitiesCollection,
  });
}
