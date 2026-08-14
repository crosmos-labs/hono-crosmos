/**
 * 3-stage entity resolution cascade. Mirrors
 * `app/engine/extractors/resolve_entity.py` and `dedup_helpers.py`.
 *
 * Stage A — embedding pre-filter: pgvector cosine distance ≤ 0.50, top 50 per
 *           extracted entity, unioned into one candidate pool.
 * Stage B — deterministic rapidfuzz matching: token_sort_ratio with
 *           RESOLVE_THRESHOLD (90) → auto-merge, CANDIDATE_THRESHOLD (60) →
 *           informational (falls through to Stage C).
 * Stage C — get_or_create_entity: INSERT ... ON CONFLICT (space_id,
 *           lower(name)) DO NOTHING, fallback SELECT.
 *
 * Concurrency-safety: the unique index `uq_entity_space_name` makes Stage C
 * race-safe across parallel ingesters.
 *
 * See .codex/pipelines.md.
 */
import {
  entities,
  type Database,
  type Entity,
} from '@crosmos/db';
import {
  createStageRecorder,
  type Logger,
  type StageRecorder,
} from '@crosmos/observability';
import { type TenantScope } from '@crosmos/types';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { VectorStore } from '@crosmos/vector';
import {
  CANDIDATE_POOL_LIMIT,
  CANDIDATE_POOL_THRESHOLD,
  CANDIDATE_THRESHOLD,
  CANDIDATE_LIMIT,
  MIN_FUZZY_LENGTH,
  RESOLVE_THRESHOLD,
} from '../constants';
import type { Embedder } from '../integrations/embeddings';
import { fuzzyExtract, tokenSortRatio } from './fuzzy';
import type { NormalizedEntity } from './types';

export interface ResolvedEntity {
  extracted: NormalizedEntity;
  entityId: number;
  isNew: boolean;
}

interface CandidateRow {
  id: number;
  name: string;
}

function casefold(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Stage A: pull a wide candidate pool from the existing graph via ANN cosine
 * search over the vector store. Scoped by org+space. `CANDIDATE_POOL_THRESHOLD`
 * is a cosine-distance ceiling (0.5), i.e. a cosine-similarity floor of
 * `1 - 0.5`. Returns the dedup'd pool — one row per entity_id even if multiple
 * extracted names matched it. Names are loaded from Postgres (the vector store
 * holds only vectors).
 */
async function fetchCandidatePool(
  db: Database,
  scope: TenantScope,
  vectorStore: VectorStore,
  embeddings: number[][],
): Promise<CandidateRow[]> {
  const ids = new Set<number>();
  const scopeArg = { orgId: scope.orgId, spaceId: scope.spaceId };
  const opts = { topK: CANDIDATE_POOL_LIMIT, minScore: 1 - CANDIDATE_POOL_THRESHOLD };
  if (vectorStore.queryNearestBatch) {
    // Batched: one backend call for all extracted-entity embeddings. Matters for
    // HTTP-backed stores (Qdrant) where each query is a counted subrequest.
    const batched = await vectorStore.queryNearestBatch('entities', embeddings, scopeArg, opts);
    for (const matches of batched) for (const m of matches) ids.add(m.id);
  } else {
    for (const emb of embeddings) {
      const matches = await vectorStore.queryNearest('entities', emb, scopeArg, opts);
      for (const m of matches) ids.add(m.id);
    }
  }
  if (ids.size === 0) return [];

  const rows = await db
    .select({ id: entities.id, name: entities.name })
    .from(entities)
    .where(
      and(
        eq(entities.orgId, scope.orgId),
        eq(entities.spaceId, scope.spaceId),
        inArray(entities.id, [...ids]),
      ),
    );
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

/**
 * Stage B: deterministic fuzzy match against the candidate pool. Returns the
 * resolved entity id if a high-confidence match is found, else null. Medium-
 * confidence candidates are *not* auto-merged (the LLM dedup pass has been
 * removed in Python) — they fall through to Stage C.
 */
function fuzzyResolve(
  name: string,
  pool: CandidateRow[],
): { entityId: number } | null {
  const folded = casefold(name);

  // 1. Exact casefold match (rarely two — if duplicates exist, fall through)
  const exact = pool.filter((c) => casefold(c.name) === folded);
  if (exact.length === 1) return { entityId: exact[0]!.id };
  if (exact.length > 1) return null;

  // 2. Length floor — refuse to fuzzy-match super-short names
  if (folded.length < MIN_FUZZY_LENGTH) return null;

  // 3. process.extract with token_sort_ratio
  const matches = fuzzyExtract<CandidateRow>(
    name,
    pool,
    (c) => c.name,
    { limit: CANDIDATE_LIMIT, scoreCutoff: CANDIDATE_THRESHOLD },
  );
  if (matches.length === 0) return null;
  const best = matches[0]!;
  if (best.score >= RESOLVE_THRESHOLD) return { entityId: best.choice.id };
  return null;
}

/**
 * Stage C: race-safe upsert by (space_id, lower(name)). Returns the resulting
 * row and whether it was just inserted.
 */
async function getOrCreateEntity(
  db: Database,
  scope: TenantScope,
  name: string,
  entityType: string,
  embedding: number[] | null,
): Promise<{ entityId: number; isNew: boolean }> {
  // The entities table has exactly one unique constraint — the partial
  // expression index `uq_entity_space_name` on (space_id, lower(name)).
  // Drizzle's `target` option doesn't support functional/expression indexes,
  // so we omit `target`: any unique conflict (only this one exists) is
  // swallowed, then we fall back to a case-insensitive SELECT to fetch the
  // existing row.
  const inserted = await db
    .insert(entities)
    .values({
      orgId: scope.orgId,
      spaceId: scope.spaceId,
      name,
      entityType,
      embedding,
    })
    .onConflictDoNothing()
    .returning({ id: entities.id });
  if (inserted.length > 0) return { entityId: inserted[0]!.id, isNew: true };

  // Conflict — fetch the existing row (case-insensitive name match within scope)
  const existing = await db
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(
        eq(entities.orgId, scope.orgId),
        eq(entities.spaceId, scope.spaceId),
        sql`lower(${entities.name}) = ${name.toLowerCase()}`,
      ),
    )
    .limit(1);
  if (existing.length === 0) {
    // Unreachable: the unique index is on (space_id, lower(name)).
    throw new Error(
      `Entity upsert conflicted but no row found for name=${name} in space=${scope.spaceId}`,
    );
  }
  return { entityId: existing[0]!.id, isNew: false };
}

/**
 * Resolve a batch of extracted entities to DB rows. One embedding round-trip
 * for the whole batch.
 */
export async function resolveEntities(
  db: Database,
  scope: TenantScope,
  extracted: NormalizedEntity[],
  embedder: Embedder,
  vectorStore: VectorStore,
  logger?: Logger,
  stageRecorder?: StageRecorder,
): Promise<ResolvedEntity[]> {
  if (extracted.length === 0) return [];
  const stages = stageRecorder ?? createStageRecorder({
    logger,
    event: 'ingestion.stage_completed',
    metric: 'ingestion_stage',
  });

  const names = extracted.map((e) => e.name);
  const { vectors } = await stages.time(
    'entity_embedding',
    { embedding_mode: 'document', embedding_count: names.length },
    () => embedder.embedBatch(names, { mode: 'document' }),
    (result) => ({ inputCount: names.length, outputCount: result.vectors.length }),
  );

  const pool = await stages.time(
    'entity_candidate_pool',
    {},
    () => fetchCandidatePool(db, scope, vectorStore, vectors),
    (candidates) => ({ inputCount: vectors.length, outputCount: candidates.length }),
  );

  const out = new Array<ResolvedEntity>(extracted.length);
  // Collect index-backed vector upserts and flush them in ONE call after the
  // loop (vs one per entity). Each is a counted subrequest on HTTP-backed
  // stores (Qdrant), so batching keeps ingestion under the per-invocation cap.
  const vectorUpserts: { id: number; vector: number[]; orgId: number; spaceId: number }[] = [];
  await stages.time('entity_upsert', {}, async () => {
    const unresolved: Array<{
      index: number;
      extracted: NormalizedEntity;
      embedding: number[] | null;
    }> = [];
    for (let i = 0; i < extracted.length; i++) {
      const e = extracted[i]!;
      const emb = vectors[i] ?? null;

      const fuzzy = pool.length > 0 ? fuzzyResolve(e.name, pool) : null;
      if (fuzzy) {
        out[i] = { extracted: e, entityId: fuzzy.entityId, isNew: false };
        continue;
      }
      unresolved.push({ index: i, extracted: e, embedding: emb });
    }

    if (unresolved.length > 0) {
      // One race-safe insert for every unresolved normalized name. The unique
      // (space_id, lower(name)) index remains the concurrency authority; a
      // concurrent winner is resolved by the single authoritative SELECT below.
      const inserted = await db
        .insert(entities)
        .values(unresolved.map(({ extracted: entity, embedding }) => ({
          orgId: scope.orgId,
          spaceId: scope.spaceId,
          name: entity.name,
          entityType: entity.entityType,
          embedding: vectorStore.persistsInColumn ? embedding : null,
        })))
        .onConflictDoNothing()
        .returning({ id: entities.id, name: entities.name });
      const normalizedNames = [...new Set(unresolved.map(({ extracted: entity }) =>
        casefold(entity.name)))];
      const authoritative = await db
        .select({ id: entities.id, name: entities.name })
        .from(entities)
        .where(and(
          eq(entities.orgId, scope.orgId),
          eq(entities.spaceId, scope.spaceId),
          inArray(sql<string>`lower(${entities.name})`, normalizedNames),
        ));
      const idByName = new Map(authoritative.map((row) => [casefold(row.name), row.id]));
      const insertedIds = new Set(inserted.map((row) => row.id));

      for (const item of unresolved) {
        const entityId = idByName.get(casefold(item.extracted.name));
        if (entityId === undefined) {
          throw new Error(
            `Entity bulk upsert completed but no row was found for ${item.extracted.name}`,
          );
        }
        out[item.index] = {
          extracted: item.extracted,
          entityId,
          isNew: insertedIds.has(entityId),
        };
        // Index-backed stores must upsert every resolved entity, including a
        // conflict left by a prior post-commit vector failure. Idempotent.
        if (!vectorStore.persistsInColumn && item.embedding) {
          vectorUpserts.push({
            id: entityId,
            vector: item.embedding,
            orgId: scope.orgId,
            spaceId: scope.spaceId,
          });
        }
      }
    }

    // Single batched vector upsert for all resolved entities in this source.
    if (vectorUpserts.length > 0) {
      // Duplicate normalized names may map to the same authoritative row. Keep
      // the final vector once instead of sending duplicate point ids.
      const byId = new Map(vectorUpserts.map((item) => [item.id, item]));
      await vectorStore.upsert('entities', [...byId.values()]);
    }
    return out;
  }, (resolved) => ({ inputCount: extracted.length, outputCount: resolved.length }));
  return out;
}

/**
 * Build the name→id map used by edge construction. Keyed by
 * `name.trim().casefold()` — the ONLY mapping edge construction uses.
 */
export function buildNameToIdMap(resolved: ResolvedEntity[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of resolved) map.set(casefold(r.extracted.name), r.entityId);
  return map;
}

// Re-exported so the entity collection step can use the same key shape.
export { casefold };

// keep tree-shaken `tokenSortRatio` referenced if needed by external callers
export { tokenSortRatio };

// keep Entity import alive for downstream consumers
export type { Entity };
