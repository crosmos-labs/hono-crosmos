import type { Database } from '@crosmos/db';
import { PgVectorStore, QdrantStore, VectorizeStore } from '@crosmos/vector';
import type { VectorStore } from '@crosmos/vector';
import type { Env } from '../../bindings';
import { getIngestionConfig } from '../../config';

export type { VectorStore } from '@crosmos/vector';

/**
 * Vector store for ingestion (writes + dedup hint + entity-resolution
 * prefilter), selected by `VECTOR_STORE`. Must match the API worker's choice so
 * reads and writes hit the same store.
 *   - `vectorize` (default) — Cloudflare Vectorize indexes via bindings.
 *   - `qdrant` — Qdrant cloud cluster over REST.
 *   - `pg` — pgvector columns on `memories`/`entities`.
 */
export function getVectorStore(env: Env, db: Database): VectorStore {
  const config = getIngestionConfig(env).vectorStore;
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
