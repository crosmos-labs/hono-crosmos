/**
 * Hand-written vector ops — port of `app/engine/helpers.py` (`normalize`,
 * `cosine_similarity`) and the numpy cosine seeding in `graph.py`. No external
 * libs; these are small loops over 1536-dim vectors. The zero-norm guards must
 * preserve deterministic ranking behavior.
 */

export function dot(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

/** L2 norm. */
export function l2norm(v: number[]): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  return Math.sqrt(s);
}

/**
 * L2-normalize. Returns the vector unchanged when its norm is zero — matches
 * `helpers.py:normalize` (`arr / norm if norm > 0 else arr`).
 */
export function normalize(v: number[]): number[] {
  const norm = l2norm(v);
  if (norm > 0) return v.map((x) => x / norm);
  return v;
}

/** `cosine_similarity(a, b) = dot(normalize(a), normalize(b))`. */
export function cosineSimilarity(a: number[], b: number[]): number {
  return dot(normalize(a), normalize(b));
}

/**
 * Graph seeding cosine: score each candidate embedding against the query.
 * Mirrors `graph.py:_seed_by_memory` / `_seed_by_entity_embedding`:
 *   - if ‖q‖ == 0 → empty map (caller returns {})
 *   - a candidate with ‖emb‖ == 0 is divided by 1e-10 (Python's
 *     `memory_norms[memory_norms == 0] = 1e-10`)
 * Returns score per index (parallel to `items`).
 */
export function seedCosineScores(
  queryEmbedding: number[],
  items: number[][],
): number[] | null {
  const qNorm = l2norm(queryEmbedding);
  if (qNorm === 0) return null;
  return items.map((emb) => {
    let embNorm = l2norm(emb);
    if (embNorm === 0) embNorm = 1e-10;
    return dot(emb, queryEmbedding) / (embNorm * qNorm);
  });
}
