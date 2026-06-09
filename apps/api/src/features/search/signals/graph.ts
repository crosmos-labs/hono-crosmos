/**
 * Graph signal — BFS over the entity/edge graph. Port of
 * `graph.py:graph_search_with_store` + `graph/postgres/graph_store.py`. This is
 * our path (Postgres store configured): edges are fetched per-hop from the DB,
 * NOT re-sorted in JS (the SQL `ORDER BY effective_time DESC, id DESC` is the
 * order). Seeding uses three strategies; an entity's relevance is the max
 * across them. See .codex/pipelines.md.
 */
import { type Database, type Entity, type Memory, edges } from '@crosmos/db';
import type { TenantScope } from '@crosmos/types';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { graphEdgeVisibilityClause } from '../../../lib/scope';
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
import { type RankedCandidate, SourceSignal } from '../types';
import { seedCosineScores } from '../vector';

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
 * Edge expansion query — port of `get_edges_for_entities`. Returns ALL
 * matching non-forgotten edges, newest-first by effective time
 * (`coalesce(valid_from, recorded_at)`), then id desc. No DISTINCT ON.
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
  if (asOf !== null) conditions.push(sql`${effectiveTime} <= ${asOf}`);

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
    .orderBy(sql`${effectiveTime} desc`, desc(edges.id));
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

/** Top-k indices (by score desc) among entries with score >= threshold. */
function topKAboveThreshold(
  scores: number[],
  threshold: number,
  k: number,
): Array<{ index: number; score: number }> {
  const kept = scores
    .map((score, index) => ({ index, score }))
    .filter((x) => x.score >= threshold);
  kept.sort((a, b) => b.score - a.score);
  return kept.slice(0, k);
}

/** Seed via memory-embedding similarity; propagate to that memory's entities. */
function seedByMemory(
  queryEmbedding: number[],
  memories: Memory[],
  memoryToEntities: Map<number, number[]>,
): Map<number, number> {
  const valid = memories.filter((m) => m.embedding !== null);
  if (valid.length === 0) return new Map();
  const scores = seedCosineScores(queryEmbedding, valid.map((m) => m.embedding!));
  if (scores === null) return new Map();

  const top = topKAboveThreshold(scores, GRAPH_SEED_THRESHOLD, GRAPH_SEED_LIMIT);
  const entityScores = new Map<number, number>();
  for (const { index, score } of top) {
    const memory = valid[index]!;
    for (const eid of memoryToEntities.get(memory.id) ?? []) {
      if (score > (entityScores.get(eid) ?? 0.0)) entityScores.set(eid, score);
    }
  }
  return entityScores;
}

/** Seed via entity-embedding similarity. */
function seedByEntityEmbedding(
  queryEmbedding: number[],
  entities: Entity[],
): Map<number, number> {
  const valid = entities.filter((e) => e.embedding !== null);
  if (valid.length === 0) return new Map();
  const scores = seedCosineScores(queryEmbedding, valid.map((e) => e.embedding!));
  if (scores === null) return new Map();

  const top = topKAboveThreshold(scores, GRAPH_SEED_THRESHOLD, GRAPH_SEED_LIMIT);
  const out = new Map<number, number>();
  for (const { index, score } of top) out.set(valid[index]!.id, score);
  return out;
}

/** Seed via token overlap on entity names (normalized to the top match). */
function seedByEntityName(
  queryText: string,
  entities: Entity[],
): Map<number, number> {
  const queryTokens = tokenize(queryText);
  if (queryTokens.size === 0) return new Map();

  const scored: Array<{ entity: Entity; score: number }> = [];
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

export async function graphSearchWithStore(
  db: Database,
  queryText: string,
  queryEmbedding: number[],
  memories: Memory[],
  entities: Entity[],
  memoryToEntities: Map<number, number[]>,
  limit: number,
  asOf: Date | null,
  maxDepth: number,
  scope: TenantScope,
): Promise<RankedCandidate[]> {
  const effectiveMaxDepth = maxDepth ?? MAX_DEPTH;
  const now = new Date();

  const memoryMap = new Map<number, Memory>();
  for (const m of memories) if (m.forgottenAt === null) memoryMap.set(m.id, m);
  if (memoryMap.size === 0) return [];

  const seedEntities =
    scope.visibleUserIds == null
      ? entities
      : entities.filter((entity) =>
          new Set([...memoryToEntities.values()].flat()).has(entity.id),
        );

  // Seed: entity relevance = max score across the three strategies.
  const seedResults = [
    seedByMemory(queryEmbedding, memories, memoryToEntities),
    seedByEntityEmbedding(queryEmbedding, seedEntities),
    seedByEntityName(queryText, seedEntities),
  ];
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
  const seedEntitySet = new Set(seedEntityIds);

  // Initial memory scores: max relevance among a memory's seed entities.
  const scores = new Map<number, number>();
  for (const [mid, eids] of memoryToEntities) {
    if (!memoryMap.has(mid)) continue;
    const seedRel = eids
      .filter((eid) => seedEntitySet.has(eid))
      .map((eid) => entityRelevance.get(eid) ?? 0.0);
    if (seedRel.length > 0) scores.set(mid, Math.max(...seedRel));
  }

  let frontier = new Set(seedEntityIds);
  let frontierRelevance = new Map<number, number>(
    seedEntityIds.map((eid) => [eid, entityRelevance.get(eid) ?? 0.0]),
  );
  const visited = new Set(seedEntityIds);

  for (let depth = 1; depth <= effectiveMaxDepth; depth++) {
    if (frontier.size === 0 || scores.size >= GRAPH_MEMORY_BUDGET) break;

    const hopEdges = await getEdgesForEntities(db, [...frontier], asOf, scope);

    // Dedup by edge id, filter by confidence. Preserve SQL order (no resort).
    const seenEdgeIds = new Set<number>();
    let filtered: EdgeRow[] = [];
    for (const edge of hopEdges) {
      if (seenEdgeIds.has(edge.id)) continue;
      seenEdgeIds.add(edge.id);
      const confidence = edge.confidence ?? 1.0;
      if (confidence >= GRAPH_MIN_CONFIDENCE) filtered.push(edge);
    }
    if (filtered.length > GRAPH_MAX_EDGES_PER_HOP) {
      filtered = filtered.slice(0, GRAPH_MAX_EDGES_PER_HOP);
    }

    const nextFrontier = new Set<number>();
    const nextFrontierRelevance = new Map<number, number>();

    for (const edge of filtered) {
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

      const memoryId = edge.memoryId;
      if (memoryId !== null && memoryMap.has(memoryId)) {
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

  const maxScore = Math.max(...scores.values());
  const normalized = new Map<number, number>();
  if (maxScore > 0) {
    for (const [mid, s] of scores) normalized.set(mid, s / maxScore);
  } else {
    for (const [mid, s] of scores) normalized.set(mid, s);
  }

  const sortedIds = [...normalized.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([mid]) => mid);

  const candidates: RankedCandidate[] = [];
  let rank = 1;
  for (const memoryId of sortedIds) {
    const memory = memoryMap.get(memoryId);
    if (memory === undefined) continue;
    candidates.push(
      toRankedCandidate(memory, rank, normalized.get(memoryId)!, SourceSignal.GRAPH),
    );
    rank++;
  }
  return candidates;
}
