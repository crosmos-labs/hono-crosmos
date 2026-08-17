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
import { type Database, edges, memories, memoryEntities } from '@crosmos/db';
import type { VectorMatch, VectorStore } from '@crosmos/vector';
import type { TenantScope } from '@crosmos/types';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { graphEdgeVisibilityClause, scopeMemories } from '../../../lib/scope';
import {
  getEntitiesByNameTokens,
  getEntitiesForMemories,
  getEntityIdsLinkedToVisibleMemories,
  getMemoriesForEntities,
  hydrateMemories,
  retrievalMemoryColumns,
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
import {
  type RankedCandidate,
  type RetrievalEntityRow,
  type RetrievalMemoryRow,
  SourceSignal,
} from '../types';

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

interface TraversalLoad {
  seedLinks: Map<number, number[]>;
  edgesByDepth: Map<number, EdgeRow[]>;
  memories: Map<number, RetrievalMemoryRow>;
}

interface TraversalSqlRow {
  [key: string]: unknown;
  kind: 'seed' | 'edge' | 'memory';
  depth: number | null;
  ordinal: number | string | null;
  entity_id: number | null;
  memory_id: number | null;
  edge_id: number | null;
  source_entity_id: number | null;
  target_entity_id: number | null;
  confidence: number | null;
  valid_from: Date | string | null;
  edge_recorded_at: Date | string | null;
  uuid: string | null;
  content: string | null;
  memory_type: RetrievalMemoryRow['memoryType'] | null;
  owner_user_id: number | null;
  org_id: number | null;
  space_id: number | null;
  importance_score: number | null;
  created_at: Date | string | null;
  memory_recorded_at: Date | string | null;
  access_frequency: number | null;
  last_accessed_at: Date | string | null;
  event_time: Date | string | null;
  forgotten_at: Date | string | null;
}

function sqlDate(value: Date | string | null): Date | null {
  if (value === null || value instanceof Date) return value;
  return new Date(value);
}

/**
 * Load the complete bounded BFS input and every potentially reached visible
 * memory in ONE Postgres round trip. Scoring stays in JavaScript below, so this
 * changes transport cost rather than ranking semantics.
 *
 * The recursive CTE carries only frontier membership and visited ids. Those are
 * independent of relevance scores: scores affect candidate ordering, while
 * membership is determined solely by the globally ordered/capped edge set at
 * each hop. Each hop preserves the existing `effective_time DESC, id DESC`
 * order and the source-endpoint precedence used when both endpoints are in the
 * frontier. We may prefetch a later hop that JS ultimately skips after hitting
 * `GRAPH_MEMORY_BUDGET`; the bounded extra rows are ignored by the unchanged
 * stop check and cannot affect output.
 */
async function loadTraversal(
  db: Database,
  seedEntityIds: number[],
  asOf: Date | null,
  scope: TenantScope,
  maxDepth: number,
): Promise<TraversalLoad> {
  if (seedEntityIds.length === 0) {
    return { seedLinks: new Map(), edgesByDepth: new Map(), memories: new Map() };
  }

  const seedArray = sql.join(seedEntityIds.map((id) => sql`${id}`), sql`, `);
  const edgeVisibility = graphEdgeVisibilityClause(scope);
  const edgeVisibilitySql = edgeVisibility === undefined ? sql`true` : edgeVisibility;
  const asOfSql = asOf === null
    ? sql`true`
    : sql`coalesce(${edges.validFrom}, ${edges.recordedAt}) <= ${asOf.toISOString()}::timestamptz`;

  const rows = await db.execute<TraversalSqlRow>(sql`
    WITH RECURSIVE
    seed_entities(entity_id) AS (
      SELECT unnest(ARRAY[${seedArray}]::integer[])
    ),
    initial_links AS MATERIALIZED (
      SELECT ${memoryEntities.entityId} AS entity_id,
             ${memoryEntities.memoryId} AS memory_id
      FROM ${memoryEntities}
      INNER JOIN ${memories} ON ${memories.id} = ${memoryEntities.memoryId}
      WHERE ${scopeMemories(scope)}
        AND ${memories.forgottenAt} IS NULL
        AND ${memoryEntities.entityId} = ANY(ARRAY[${seedArray}]::integer[])
      ORDER BY ${memoryEntities.entityId}, ${memoryEntities.memoryId}
    ),
    walk(depth, frontier, visited, edge_ids) AS (
      SELECT 0,
             ARRAY[${seedArray}]::integer[],
             ARRAY[${seedArray}]::integer[],
             ARRAY[]::integer[]
      UNION ALL
      SELECT walk.depth + 1,
             hop.next_frontier,
             walk.visited || hop.next_frontier,
             hop.edge_ids
      FROM walk
      CROSS JOIN LATERAL (
        WITH edge_candidates AS MATERIALIZED (
          SELECT ${edges.id} AS id,
                 ${edges.sourceEntityId} AS source_entity_id,
                 ${edges.targetEntityId} AS target_entity_id,
                 coalesce(${edges.validFrom}, ${edges.recordedAt}) AS effective_time
          FROM ${edges}
          WHERE ${edges.forgottenAt} IS NULL
            AND ${edges.orgId} = ${scope.orgId}
            AND ${edges.spaceId} = ${scope.spaceId}
            AND ${edgeVisibilitySql}
            AND coalesce(${edges.confidence}, 1.0) >= ${GRAPH_MIN_CONFIDENCE}::double precision
            AND ${asOfSql}
            AND (
              ${edges.sourceEntityId} = ANY(walk.frontier)
              OR ${edges.targetEntityId} = ANY(walk.frontier)
            )
          ORDER BY coalesce(${edges.validFrom}, ${edges.recordedAt}) DESC,
                   ${edges.id} DESC
          LIMIT ${GRAPH_MAX_EDGES_PER_HOP}
        ),
        steps AS (
          SELECT id,
                 row_number() OVER (ORDER BY effective_time DESC, id DESC) AS ordinal,
                 CASE
                   WHEN source_entity_id = ANY(walk.frontier) THEN target_entity_id
                   ELSE source_entity_id
                 END AS other
          FROM edge_candidates
        ),
        next_entities AS (
          SELECT other, min(ordinal) AS first_ordinal
          FROM steps
          WHERE NOT (other = ANY(walk.visited))
          GROUP BY other
        )
        SELECT coalesce(
                 (SELECT array_agg(id ORDER BY ordinal) FROM steps),
                 ARRAY[]::integer[]
               ) AS edge_ids,
               coalesce(
                 (SELECT array_agg(other ORDER BY first_ordinal) FROM next_entities),
                 ARRAY[]::integer[]
               ) AS next_frontier
      ) AS hop
      WHERE walk.depth < ${maxDepth}
        AND cardinality(walk.frontier) > 0
    ),
    walk_edges AS MATERIALIZED (
      SELECT walk.depth,
             expanded.ordinality AS ordinal,
             expanded.edge_id
      FROM walk
      CROSS JOIN LATERAL unnest(walk.edge_ids)
        WITH ORDINALITY AS expanded(edge_id, ordinality)
      WHERE walk.depth > 0
    ),
    all_memory_ids AS MATERIALIZED (
      SELECT memory_id FROM initial_links
      UNION
      SELECT ${edges.memoryId}
      FROM walk_edges
      INNER JOIN ${edges} ON ${edges.id} = walk_edges.edge_id
      WHERE ${edges.memoryId} IS NOT NULL
    )
    SELECT 'seed'::text AS kind,
           NULL::integer AS depth,
           NULL::bigint AS ordinal,
           initial_links.entity_id,
           initial_links.memory_id,
           NULL::integer AS edge_id,
           NULL::integer AS source_entity_id,
           NULL::integer AS target_entity_id,
           NULL::double precision AS confidence,
           NULL::timestamptz AS valid_from,
           NULL::timestamptz AS edge_recorded_at,
           NULL::uuid AS uuid,
           NULL::text AS content,
           NULL::memory_type AS memory_type,
           NULL::integer AS owner_user_id,
           NULL::integer AS org_id,
           NULL::integer AS space_id,
           NULL::double precision AS importance_score,
           NULL::timestamptz AS created_at,
           NULL::timestamptz AS memory_recorded_at,
           NULL::integer AS access_frequency,
           NULL::timestamptz AS last_accessed_at,
           NULL::timestamptz AS event_time,
           NULL::timestamptz AS forgotten_at
    FROM initial_links

    UNION ALL

    SELECT 'edge',
           walk_edges.depth,
           walk_edges.ordinal,
           NULL,
           ${edges.memoryId},
           ${edges.id},
           ${edges.sourceEntityId},
           ${edges.targetEntityId},
           ${edges.confidence},
           ${edges.validFrom},
           ${edges.recordedAt},
           NULL, NULL, NULL::memory_type, NULL, NULL, NULL, NULL, NULL,
           NULL, NULL, NULL, NULL, NULL
    FROM walk_edges
    INNER JOIN ${edges} ON ${edges.id} = walk_edges.edge_id

    UNION ALL

    SELECT 'memory',
           NULL,
           NULL,
           NULL,
           ${retrievalMemoryColumns.id},
           NULL, NULL, NULL, NULL, NULL, NULL,
           ${retrievalMemoryColumns.uuid},
           ${retrievalMemoryColumns.content},
           ${retrievalMemoryColumns.memoryType},
           ${retrievalMemoryColumns.ownerUserId},
           ${retrievalMemoryColumns.orgId},
           ${retrievalMemoryColumns.spaceId},
           ${retrievalMemoryColumns.importanceScore},
           ${retrievalMemoryColumns.createdAt},
           ${retrievalMemoryColumns.recordedAt},
           ${retrievalMemoryColumns.accessFrequency},
           ${retrievalMemoryColumns.lastAccessedAt},
           ${retrievalMemoryColumns.eventTime},
           ${retrievalMemoryColumns.forgottenAt}
    FROM ${memories}
    INNER JOIN all_memory_ids ON all_memory_ids.memory_id = ${memories.id}
    WHERE ${scopeMemories(scope)}
      AND ${memories.forgottenAt} IS NULL
  `);

  const seedLinks = new Map<number, number[]>();
  const edgesByDepth = new Map<number, Array<EdgeRow & { ordinal: number }>>();
  const memoryRows = new Map<number, RetrievalMemoryRow>();

  for (const row of rows) {
    if (row.kind === 'seed' && row.entity_id !== null && row.memory_id !== null) {
      const links = seedLinks.get(row.entity_id);
      if (links) links.push(row.memory_id);
      else seedLinks.set(row.entity_id, [row.memory_id]);
      continue;
    }
    if (
      row.kind === 'edge'
      && row.depth !== null
      && row.ordinal !== null
      && row.edge_id !== null
      && row.source_entity_id !== null
      && row.target_entity_id !== null
      && row.edge_recorded_at !== null
    ) {
      const list = edgesByDepth.get(row.depth) ?? [];
      list.push({
        ordinal: Number(row.ordinal),
        id: row.edge_id,
        sourceEntityId: row.source_entity_id,
        targetEntityId: row.target_entity_id,
        memoryId: row.memory_id,
        confidence: row.confidence,
        validFrom: sqlDate(row.valid_from),
        recordedAt: sqlDate(row.edge_recorded_at)!,
      });
      edgesByDepth.set(row.depth, list);
      continue;
    }
    if (
      row.kind === 'memory'
      && row.memory_id !== null
      && row.uuid !== null
      && row.content !== null
      && row.memory_type !== null
      && row.org_id !== null
      && row.space_id !== null
      && row.created_at !== null
      && row.memory_recorded_at !== null
      && row.access_frequency !== null
      && row.last_accessed_at !== null
    ) {
      memoryRows.set(row.memory_id, {
        id: row.memory_id,
        uuid: row.uuid,
        content: row.content,
        memoryType: row.memory_type,
        ownerUserId: row.owner_user_id,
        orgId: row.org_id,
        spaceId: row.space_id,
        importanceScore: row.importance_score,
        createdAt: sqlDate(row.created_at)!,
        recordedAt: sqlDate(row.memory_recorded_at)!,
        accessFrequency: row.access_frequency,
        lastAccessedAt: sqlDate(row.last_accessed_at)!,
        eventTime: sqlDate(row.event_time),
        forgottenAt: sqlDate(row.forgotten_at),
      });
    }
  }

  const orderedEdges = new Map<number, EdgeRow[]>();
  for (const [depth, depthEdges] of edgesByDepth) {
    depthEdges.sort((a, b) => a.ordinal - b.ordinal);
    orderedEdges.set(depth, depthEdges.map(({ ordinal: _ordinal, ...edge }) => edge));
  }
  return { seedLinks, edgesByDepth: orderedEdges, memories: memoryRows };
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

  const commonConditions = [
    isNull(edges.forgottenAt),
  ];
  commonConditions.push(eq(edges.orgId, scope.orgId), eq(edges.spaceId, scope.spaceId));
  const edgeVisibility = graphEdgeVisibilityClause(scope);
  if (edgeVisibility !== undefined) commonConditions.push(edgeVisibility);
  // A NULL confidence means "unspecified", which the traversal has always read
  // as full confidence — keep that reading here rather than letting the NULL
  // comparison silently drop the row.
  commonConditions.push(
    sql`coalesce(${edges.confidence}, 1.0) >= ${GRAPH_MIN_CONFIDENCE}::double precision`,
  );
  // ISO string + cast, not a raw Date: a Date in a raw `sql` template is sent
  // untyped and the postgres.js driver rejects it ("must be string"). Only bites
  // when asOf is set (temporal + graph queries), so it was a latent bug.
  if (asOf !== null) {
    commonConditions.push(sql`${effectiveTime} <= ${asOf.toISOString()}::timestamptz`);
  }

  const selection = {
    id: edges.id,
    sourceEntityId: edges.sourceEntityId,
    targetEntityId: edges.targetEntityId,
    memoryId: edges.memoryId,
    confidence: edges.confidence,
    validFrom: edges.validFrom,
    recordedAt: edges.recordedAt,
  };
  const sourceBranch = db
    .select(selection)
    .from(edges)
    .where(and(...commonConditions, inArray(edges.sourceEntityId, entityIds)));
  const targetBranch = db
    .select(selection)
    .from(edges)
    .where(and(...commonConditions, inArray(edges.targetEntityId, entityIds)));
  const candidates = db.$with('edge_candidates').as(sourceBranch.unionAll(targetBranch));
  // An edge whose two endpoints are both in the frontier appears in both
  // branches. Dedup the identical row before applying the one global ordering
  // and per-hop limit, preserving the former OR-query result exactly.
  const deduped = db.$with('deduped_edges').as(
    db.with(candidates)
      .selectDistinct({
        id: candidates.id,
        sourceEntityId: candidates.sourceEntityId,
        targetEntityId: candidates.targetEntityId,
        memoryId: candidates.memoryId,
        confidence: candidates.confidence,
        validFrom: candidates.validFrom,
        recordedAt: candidates.recordedAt,
      })
      .from(candidates),
  );
  return db
    .with(candidates, deduped)
    .select()
    .from(deduped)
    .orderBy(
      sql`coalesce(${deduped.validFrom}, ${deduped.recordedAt}) desc`,
      desc(deduped.id),
    )
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
  matchesOverride?: VectorMatch[],
): Promise<Map<number, number>> {
  const matches = matchesOverride ?? await vectorStore.queryNearest(
    'memories',
    queryEmbedding,
    scope,
    { topK: GRAPH_SEED_LIMIT, minScore: GRAPH_SEED_THRESHOLD, signal },
  );
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
  /** Precomputed memory ANN seed from the heterogeneous Qdrant batch. */
  memorySeedMatches?: VectorMatch[];
  /**
   * Differential-test seam for the historical edge loader. Production callers
   * omit this and always use the bounded UNION query above.
   */
  edgeLoader?: typeof getEdgesForEntities;
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
    seedByMemory(
      db,
      vectorStore,
      queryEmbedding,
      scope,
      options?.signal,
      options?.memorySeedMatches,
    ),
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

  // Production collapses seed-memory expansion, every bounded BFS hop and final
  // visible-memory hydration into one recursive SQL round trip. The injectable
  // edge loader keeps the historical multi-query path solely as a differential
  // test oracle; production callers never pass it.
  const traversal = options?.edgeLoader === undefined
    ? await loadTraversal(db, seedEntityIds, asOf, scope, effectiveMaxDepth)
    : null;
  const seedEntityMemLinks = traversal?.seedLinks
    ?? await getMemoriesForEntities(db, scope, seedEntityIds);
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
    const hopEdges = traversal
      ? traversal.edgesByDepth.get(depth) ?? []
      : await options!.edgeLoader!(db, [...frontier], asOf, scope);

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
  const rows = traversal?.memories
    ?? await hydrateMemories(db, scope, [...scores.keys()]);
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
