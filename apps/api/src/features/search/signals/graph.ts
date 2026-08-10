/**
 * Graph signal — BFS over the entity/edge graph. Port of
 * `graph.py:graph_search_with_store` + `graph/postgres/graph_store.py`. This is
 * our path (Postgres store configured): edges are fetched per-hop from the DB,
 * NOT re-sorted in JS (the SQL `ORDER BY effective_time DESC, id DESC` is the
 * order). Seeding uses three strategies; an entity's relevance is the max
 * across them. See .codex/pipelines.md.
 *
 * Working-set model: this signal is self-contained and BOUNDED. It does not
 * receive a pre-loaded space. It loads in-scope entities (id+name) for the
 * lexical/embedding seeds, fetches memory↔entity links only for the handful of
 * seed/ANN ids it touches, and hydrates the reached memories by id at the end.
 * Every memory read goes through `scopeMemories` (org + space + per-user
 * visibility), so relevance never propagates through, nor is a candidate ever
 * emitted from, a memory the caller cannot see — the final hydration is the
 * visibility gate.
 */
import { type Database, edges } from '@crosmos/db';
import type { VectorStore } from '@crosmos/vector';
import type { TenantScope } from '@crosmos/types';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { graphEdgeVisibilityClause } from '../../../lib/scope';
import {
  getEntitiesByNameTokens,
  getEntitiesForMemories,
  getEntityIdsLinkedToVisibleMemories,
  getMemoriesForEntities,
  hydrateMemories,
} from '../candidates';
import {
  DEPTH_DECAY,
  GRAPH_EDGE_RECENCY_DAYS,
  GRAPH_EDGE_RECENCY_FLOOR,
  GRAPH_MAX_EDGES_PER_HOP,
  GRAPH_MAX_SEED_ENTITIES,
  GRAPH_MEMORY_BUDGET,
  GRAPH_MIN_CONFIDENCE,
  GRAPH_SEED_LIMIT,
  GRAPH_SEED_THRESHOLD,
  MAX_DEPTH,
} from '../constants';
import { toRankedCandidate } from '../mapping';
import { intersectionSize, tokenize } from '../tokenize';
import { type RankedCandidate, type RetrievalEntityRow, SourceSignal } from '../types';

const SEC_PER_DAY = 86400;

interface EdgeRow {
  id: number;
  sourceEntityId: number;
  targetEntityId: number;
  memoryId: number | null;
  confidence: number | null;
  validFrom: Date | null;
  recordedAt: Date;
}

/**
 * Edge expansion query — port of `get_edges_for_entities`. Returns matching
 * non-forgotten edges at or above `GRAPH_MIN_CONFIDENCE`, newest-first by
 * effective time (`coalesce(valid_from, recorded_at)`), then id desc, bounded to
 * `GRAPH_MAX_EDGES_PER_HOP`. No DISTINCT ON.
 *
 * The confidence rule and the per-hop cap used to run in JavaScript over an
 * UNBOUNDED result set: a high-degree entity transferred every one of its edges
 * out of Postgres so that all but the first 200 could be discarded in the
 * Worker. Both are now expressed in SQL, which is exactly equivalent because:
 *
 *  - `coalesce(confidence, 1.0) >= x` reproduces the JS `edge.confidence ?? 1.0`
 *    default, and `confidence` is `double precision`, so the comparison happens
 *    on the same IEEE double the driver would have handed JavaScript;
 *  - the ordering is total (`id` is unique), so `LIMIT` takes precisely the rows
 *    the JS `slice` took;
 *  - the JS pass also deduped by edge id, which was always a no-op — this is a
 *    single-table select with no join, so a row can match at most once.
 */
export async function getEdgesForEntities(
  db: Database,
  entityIds: number[],
  asOf: Date | null,
  scope: TenantScope,
): Promise<EdgeRow[]> {
  if (entityIds.length === 0) return [];
  const effectiveTime = sql`coalesce(${edges.validFrom}, ${edges.recordedAt})`;

  const conditions = [
    isNull(edges.forgottenAt),
    or(
      inArray(edges.sourceEntityId, entityIds),
      inArray(edges.targetEntityId, entityIds),
    )!,
  ];
  conditions.push(eq(edges.orgId, scope.orgId), eq(edges.spaceId, scope.spaceId));
  const edgeVisibility = graphEdgeVisibilityClause(scope);
  if (edgeVisibility !== undefined) conditions.push(edgeVisibility);
  // A NULL confidence means "unspecified", which the traversal has always read
  // as full confidence — keep that reading here rather than letting the NULL
  // comparison silently drop the row.
  conditions.push(
    sql`coalesce(${edges.confidence}, 1.0) >= ${GRAPH_MIN_CONFIDENCE}::double precision`,
  );
  // ISO string + cast, not a raw Date: a Date in a raw `sql` template is sent
  // untyped and the postgres.js driver rejects it ("must be string"). Only bites
  // when asOf is set (temporal + graph queries), so it was a latent bug.
  if (asOf !== null) conditions.push(sql`${effectiveTime} <= ${asOf.toISOString()}::timestamptz`);

  return db
    .select({
      id: edges.id,
      sourceEntityId: edges.sourceEntityId,
      targetEntityId: edges.targetEntityId,
      memoryId: edges.memoryId,
      confidence: edges.confidence,
      validFrom: edges.validFrom,
      recordedAt: edges.recordedAt,
    })
    .from(edges)
    .where(and(...conditions))
    .orderBy(sql`${effectiveTime} desc`, desc(edges.id))
    .limit(GRAPH_MAX_EDGES_PER_HOP);
}

function edgeRecencyFactor(
  validFrom: Date | null,
  recordedAt: Date | null,
  now: Date,
): number {
  const effective = validFrom ?? recordedAt;
  if (effective === null) return 1.0;
  const ageDays = Math.max((now.getTime() - effective.getTime()) / 1000 / SEC_PER_DAY, 0.0);
  const decay = 1.0 - ageDays / GRAPH_EDGE_RECENCY_DAYS;
  return Math.max(GRAPH_EDGE_RECENCY_FLOOR, Math.min(1.0, decay));
}

/**
 * Seed via memory-embedding similarity; propagate to that memory's entities.
 * ANN query against the vector store (top-`GRAPH_SEED_LIMIT` above
 * `GRAPH_SEED_THRESHOLD`), then propagate each hit's similarity to the entities
 * linked to that memory (max). Links are fetched only for the (few) hit ids and
 * the join enforces visibility, so an ANN hit the caller can't see contributes
 * nothing. Approximate under an external ANN store vs. the exact in-memory
 * cosine the pg path would do — accepted for the latency win.
 */
async function seedByMemory(
  db: Database,
  vectorStore: VectorStore,
  queryEmbedding: number[],
  scope: TenantScope,
  signal?: AbortSignal,
): Promise<Map<number, number>> {
  const matches = await vectorStore.queryNearest('memories', queryEmbedding, scope, {
    topK: GRAPH_SEED_LIMIT,
    minScore: GRAPH_SEED_THRESHOLD,
    signal,
  });
  if (matches.length === 0) return new Map();
  const links = await getEntitiesForMemories(db, scope, matches.map((m) => m.id));
  const entityScores = new Map<number, number>();
  for (const { id, score } of matches) {
    for (const eid of links.get(id) ?? []) {
      if (score > (entityScores.get(eid) ?? 0.0)) entityScores.set(eid, score);
    }
  }
  return entityScores;
}

/**
 * Seed via token overlap on entity names (normalized to the top match). Operates
 * over the bounded candidate set fetched by `getEntitiesByNameTokens` (entities
 * sharing a query token) rather than the whole space; the overlap math and
 * top-of-set normalization are identical to scanning every entity, since only
 * overlap>0 entities ever contributed.
 */
function seedByEntityName(
  queryTokens: Set<string>,
  entities: RetrievalEntityRow[],
): Map<number, number> {
  if (queryTokens.size === 0) return new Map();

  const scored: Array<{ entity: RetrievalEntityRow; score: number }> = [];
  for (const entity of entities) {
    const overlap = intersectionSize(queryTokens, tokenize(entity.name));
    if (overlap > 0) scored.push({ entity, score: overlap / queryTokens.size });
  }
  if (scored.length === 0) return new Map();

  const maxScore = Math.max(...scored.map((s) => s.score));
  if (maxScore <= 0) return new Map();

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, GRAPH_SEED_LIMIT);
  const out = new Map<number, number>();
  for (const { entity, score } of top) out.set(entity.id, score / maxScore);
  return out;
}

export interface GraphSearchOptions {
  /**
   * Called once per search with the seed-entity → memory fanout, so the
   * orchestrator can log/measure it. Observational only: it must not influence
   * traversal, and it is optional so direct callers and tests can ignore it.
   */
  onSeedFanout?(stats: { seedEntityCount: number; memoryCount: number }): void;
  /** Request deadline, forwarded to the vector store's remote calls. */
  signal?: AbortSignal;
}

export async function graphSearchWithStore(
  db: Database,
  vectorStore: VectorStore,
  queryText: string,
  queryEmbedding: number[],
  scope: TenantScope,
  limit: number,
  asOf: Date | null,
  maxDepth: number,
  options?: GraphSearchOptions,
): Promise<RankedCandidate[]> {
  const effectiveMaxDepth = maxDepth ?? MAX_DEPTH;
  const now = new Date();

  const queryTokens = tokenize(queryText);

  // Bounded seed inputs — NO whole-space entity scan. Run in parallel:
  //  - name candidates: simple-GIN lookup of in-scope entities sharing a query token
  //  - entity ANN hits (already org+space scoped by queryNearest)
  //  - memory ANN seed (propagates to entities via visible links)
  const [nameCandidatesRaw, entityAnnHits, memSeed] = await Promise.all([
    getEntitiesByNameTokens(db, scope, [...queryTokens]),
    vectorStore.queryNearest('entities', queryEmbedding, scope, {
      topK: GRAPH_SEED_LIMIT,
      minScore: GRAPH_SEED_THRESHOLD,
      signal: options?.signal,
    }),
    seedByMemory(db, vectorStore, queryEmbedding, scope, options?.signal),
  ]);

  // Visibility gate for the entity seeds: when per-user visibility is active,
  // keep only entities linked to ≥1 visible memory — parity with the old
  // universe filter, but computed over the bounded candidate ids (name matches ∪
  // ANN hits), never all entities. (The memory seed already propagates only
  // through visible links, so it needs no extra filter.)
  let nameCandidates = nameCandidatesRaw;
  let entityHits = entityAnnHits;
  if (scope.visibleUserIds != null) {
    const candidateIds = [
      ...new Set([...nameCandidatesRaw.map((e) => e.id), ...entityAnnHits.map((h) => h.id)]),
    ];
    const visible = await getEntityIdsLinkedToVisibleMemories(db, scope, candidateIds);
    nameCandidates = nameCandidatesRaw.filter((e) => visible.has(e.id));
    entityHits = entityAnnHits.filter((h) => visible.has(h.id));
  }

  const entSeed = new Map<number, number>();
  for (const { id, score } of entityHits) entSeed.set(id, score);

  // Seed: entity relevance = max score across the three strategies.
  const seedResults = [memSeed, entSeed, seedByEntityName(queryTokens, nameCandidates)];
  const entityRelevance = new Map<number, number>();
  for (const sd of seedResults) {
    for (const [eid, score] of sd) {
      if (score > (entityRelevance.get(eid) ?? 0.0)) entityRelevance.set(eid, score);
    }
  }
  if (entityRelevance.size === 0) return [];

  const seedEntityIds = [...entityRelevance.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, GRAPH_MAX_SEED_ENTITIES)
    .map(([eid]) => eid);

  // Initial memory scores: max relevance among a memory's seed entities. Fetch
  // only the (visible) memories linked to the seed entities — bounded by the ≤10
  // seed entities, not the space.
  const seedEntityMemLinks = await getMemoriesForEntities(db, scope, seedEntityIds);
  const memoryToSeedEntities = new Map<number, number[]>();
  for (const [eid, mids] of seedEntityMemLinks) {
    for (const mid of mids) {
      const list = memoryToSeedEntities.get(mid);
      if (list) list.push(eid);
      else memoryToSeedEntities.set(mid, [eid]);
    }
  }
  // Seed-entity → memory fanout is the one remaining unbounded read in this
  // signal: a hub entity linked to a large share of a space's memories drags all
  // of them in. It is deliberately MEASURED, not capped — a cap would change
  // graph recall, and there is no evidence yet of what a safe bound is. Decide
  // from this number, not from intuition.
  options?.onSeedFanout?.({
    seedEntityCount: seedEntityIds.length,
    memoryCount: memoryToSeedEntities.size,
  });
  const scores = new Map<number, number>();
  for (const [mid, eids] of memoryToSeedEntities) {
    const seedRel = eids.map((eid) => entityRelevance.get(eid) ?? 0.0);
    if (seedRel.length > 0) scores.set(mid, Math.max(...seedRel));
  }

  let frontier = new Set(seedEntityIds);
  let frontierRelevance = new Map<number, number>(
    seedEntityIds.map((eid) => [eid, entityRelevance.get(eid) ?? 0.0]),
  );
  const visited = new Set(seedEntityIds);

  for (let depth = 1; depth <= effectiveMaxDepth; depth++) {
    if (frontier.size === 0 || scores.size >= GRAPH_MEMORY_BUDGET) break;

    // Already confidence-filtered, ordered and capped by SQL — see
    // `getEdgesForEntities`. Preserve that order; do not re-sort.
    const hopEdges = await getEdgesForEntities(db, [...frontier], asOf, scope);

    const nextFrontier = new Set<number>();
    const nextFrontierRelevance = new Map<number, number>();

    for (const edge of hopEdges) {
      const confidence = edge.confidence ?? 1.0;
      const src = edge.sourceEntityId;
      const tgt = edge.targetEntityId;

      let anchorRelevance: number;
      let other: number;
      if (frontier.has(src)) {
        anchorRelevance = frontierRelevance.get(src) ?? 0.0;
        other = tgt;
      } else if (frontier.has(tgt)) {
        anchorRelevance = frontierRelevance.get(tgt) ?? 0.0;
        other = src;
      } else {
        continue;
      }

      const recency = edgeRecencyFactor(edge.validFrom, edge.recordedAt, now);
      const score =
        confidence * Math.exp(-DEPTH_DECAY * depth) * anchorRelevance * recency;

      // Score the edge's memory. Visibility is enforced at the final hydration
      // (this id set may include not-yet-verified memories; non-visible ones are
      // dropped before normalization below).
      const memoryId = edge.memoryId;
      if (memoryId !== null) {
        if (score > (scores.get(memoryId) ?? 0.0)) scores.set(memoryId, score);
      }

      if (!visited.has(other) && !nextFrontier.has(other)) {
        nextFrontier.add(other);
        visited.add(other);
      }
      if (score > (nextFrontierRelevance.get(other) ?? 0.0)) {
        nextFrontierRelevance.set(other, score);
      }
    }

    frontier = nextFrontier;
    frontierRelevance = nextFrontierRelevance;
  }

  if (scores.size === 0) return [];

  // Visibility gate + hydration: one by-id fetch for every scored memory.
  // `scopeMemories` drops ids the caller can't see / forgotten ids, so they
  // never reach the candidate list — and are excluded BEFORE normalization so
  // the max is taken over the visible set (parity with the old visible-only
  // `scores` map).
  const rows = await hydrateMemories(db, scope, [...scores.keys()]);
  const visibleScores = new Map<number, number>();
  for (const [mid, s] of scores) {
    if (rows.has(mid)) visibleScores.set(mid, s);
  }
  if (visibleScores.size === 0) return [];

  const maxScore = Math.max(...visibleScores.values());
  const normalized = new Map<number, number>();
  if (maxScore > 0) {
    for (const [mid, s] of visibleScores) normalized.set(mid, s / maxScore);
  } else {
    for (const [mid, s] of visibleScores) normalized.set(mid, s);
  }

  const sortedIds = [...normalized.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([mid]) => mid);

  const candidates: RankedCandidate[] = [];
  let rank = 1;
  for (const memoryId of sortedIds) {
    const memory = rows.get(memoryId);
    if (memory === undefined) continue;
    candidates.push(
      toRankedCandidate(memory, rank, normalized.get(memoryId)!, SourceSignal.GRAPH),
    );
    rank++;
  }
  return candidates;
}
