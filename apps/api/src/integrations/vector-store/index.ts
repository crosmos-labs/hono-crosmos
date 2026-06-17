import type { Database } from '@crosmos/db';
import { PgVectorStore, QdrantStore, VectorizeStore } from '@crosmos/vector';
import type { VectorStore } from '@crosmos/vector';
import type { Env } from '../../bindings';

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
  const backend = env.VECTOR_STORE ?? 'vectorize';
  if (backend === 'pg') {
    return new PgVectorStore(db);
  }
  if (backend === 'qdrant') {
    return buildQdrantStore(env);
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
