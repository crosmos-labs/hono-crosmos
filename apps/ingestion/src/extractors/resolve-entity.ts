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
import { durationMs, type Logger } from '@crosmos/observability';
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
  for (const emb of embeddings) {
    const matches = await vectorStore.queryNearest(
      'entities',
      emb,
      { orgId: scope.orgId, spaceId: scope.spaceId },
      { topK: CANDIDATE_POOL_LIMIT, minScore: 1 - CANDIDATE_POOL_THRESHOLD },
    );
    for (const m of matches) ids.add(m.id);
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
): Promise<ResolvedEntity[]> {
  if (extracted.length === 0) return [];

  const names = extracted.map((e) => e.name);
  const embedStart = performance.now();
  const { vectors } = await embedder.embedBatch(names, { mode: 'document' });
  logger?.info('embedding.request_completed', {
    stage: 'entity_embedding',
    embedding_mode: 'document',
    embedding_count: names.length,
    duration_ms: durationMs(embedStart),
  });

  const candidatePoolStart = performance.now();
  const pool = await fetchCandidatePool(db, scope, vectorStore, vectors);
  logger?.info('ingestion.stage_completed', {
    stage: 'entity_candidate_pool',
    duration_ms: durationMs(candidatePoolStart),
    candidate_count: pool.length,
  });

  const upsertStart = performance.now();
  const out: ResolvedEntity[] = [];
  for (let i = 0; i < extracted.length; i++) {
    const e = extracted[i]!;
    const emb = vectors[i] ?? null;

    const fuzzy = pool.length > 0 ? fuzzyResolve(e.name, pool) : null;
    if (fuzzy) {
      out.push({ extracted: e, entityId: fuzzy.entityId, isNew: false });
      continue;
    }
    // pg backend stores the vector in the column; vectorize keeps it null on
    // the row and gets the vector upserted to the index after insert.
    const columnEmbedding = vectorStore.persistsInColumn ? emb : null;
    const upserted = await getOrCreateEntity(db, scope, e.name, e.entityType, columnEmbedding);
    // Index-backed stores (vectorize): upsert the vector for EVERY resolved
    // entity in this run, not only freshly-inserted ones. The row commits in
    // autocommit above; if a prior run's vector upsert failed AFTER the row
    // committed (Workers-AI/Vectorize 429/503 — the documented prod ceiling),
    // `purgeSourceArtifacts` preserves the entity, so the retry sees
    // `isNew=false` and would otherwise NEVER re-upsert — leaving the entity
    // permanently invisible to ANN resolution. Vectorize upsert is idempotent,
    // so re-upserting an existing vector is safe and cheap. The pg backend
    // persists the vector in-column, so it's excluded here.
    if (!vectorStore.persistsInColumn && emb) {
      await vectorStore.upsert('entities', [
        { id: upserted.entityId, vector: emb, orgId: scope.orgId, spaceId: scope.spaceId },
      ]);
    }
    out.push({
      extracted: e,
      entityId: upserted.entityId,
      isNew: upserted.isNew,
    });
  }
  logger?.info('ingestion.stage_completed', {
    stage: 'entity_upsert',
    duration_ms: durationMs(upsertStart),
    entity_count: out.length,
  });
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
