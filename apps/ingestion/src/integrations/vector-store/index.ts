import type { Database } from '@crosmos/db';
import { PgVectorStore, QdrantStore, VectorizeStore } from '@crosmos/vector';
import type { VectorStore } from '@crosmos/vector';
import type { Env } from '../../bindings';

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
  const backend = env.VECTOR_STORE ?? 'vectorize';
  if (backend === 'pg') {
    return new PgVectorStore(db);
  }
  if (backend === 'qdrant') {
    if (!env.QDRANT_URL || !env.QDRANT_API_KEY) {
      throw new Error('QDRANT_URL/QDRANT_API_KEY are required for VECTOR_STORE=qdrant');
    }
    return new QdrantStore({
      url: env.QDRANT_URL,
      apiKey: env.QDRANT_API_KEY,
      memoriesCollection: env.QDRANT_MEMORIES_COLLECTION ?? 'crosmos-memories',
      entitiesCollection: env.QDRANT_ENTITIES_COLLECTION ?? 'crosmos-entities',
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
