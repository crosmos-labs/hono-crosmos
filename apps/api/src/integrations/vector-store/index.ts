import type { Database } from '@crosmos/db';
import { PgVectorStore, VectorizeStore } from '@crosmos/vector';
import type { VectorStore } from '@crosmos/vector';
import type { Env } from '../../bindings';

export type { VectorStore } from '@crosmos/vector';

/**
 * Vector store for the retrieval read path, selected by `VECTOR_STORE`:
 *   - `vectorize` (default) — Cloudflare Vectorize indexes via bindings.
 *     Edge-native ANN. Vectors live in the index, not Postgres.
 *   - `pg` — pgvector columns on `memories`/`entities` (original behaviour).
 *     Kept selectable for reversibility.
 */
export function getVectorStore(env: Env, db: Database): VectorStore {
  const backend = env.VECTOR_STORE ?? 'vectorize';
  if (backend === 'pg') {
    return new PgVectorStore(db);
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
