/**
 * Retrieval orchestrator — port of `RetrievalService.retrieve`
 * (`app/engine/retrieval/service.py`). This is the spine: the 10-stage order
 * and scoring assembly below ARE the ranking. See docs/retrieval_migration/
 * service.md. Runs inline (no queue) per decisions.md §1.
 */
import type { Embedder, Reranker } from '@crosmos/ai';
import type { Database } from '@crosmos/db';
import type { TenantScope } from '@crosmos/types';
import { attachSourceText, type RetrievalCandidates } from './candidates';
import {
  BOOST_MAX,
  BOOST_MIN,
  MAX_DEPTH,
  RECENCY_ALPHA,
  RECENCY_ALPHA_FALLBACK,
  RECENCY_CENTER,
  RERANKER_MAX_CANDIDATES,
  TEMPORAL_CANDIDATE_LIMIT,
  TEMPORAL_CENTER,
  TEMPORAL_PROXIMITY_ALPHA,
} from './constants';
import {
  computePersistence,
  computeRecency,
  mmrRerank,
  rankRemap,
  reciprocalRankFusion,
} from './fusion';
import { getEntitlements } from '../orgs/entitlements';
import { rerankCandidates } from './reranker';
import { keywordSearch } from './signals/keyword';
import { semanticSearch } from './signals/semantic';
import { graphSearchWithStore } from './signals/graph';
import {
  extractTemporalRange,
  temporalProximityScore,
  temporalSearch,
  type TemporalRange,
} from './temporal';
import {
  type CandidateMemory,
  type RankedCandidate,
  type RetrievalQuery,
  type RetrievalResult,
  SourceSignal,
} from './types';

export interface RetrieveDeps {
  db: Database;
  embedder: Embedder;
  reranker: Reranker | null;
}

export interface RetrieveInput {
  query: RetrievalQuery;
  scope: TenantScope;
  candidates: RetrievalCandidates;
  deps: RetrieveDeps;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export async function retrieve(input: RetrieveInput): Promise<RetrievalResult> {
  const { query, scope, candidates, deps } = input;
  const { db, embedder, reranker } = deps;

  // Stage 0 — temporal range (drives temporal signal, graph as_of, pool filter, boost).
  const temporalRange = extractTemporalRange(query.text);

  // Stage 1 — entitlements → feature flags. Non-fatal on failure (defaults).
  let entitlements: Awaited<ReturnType<typeof getEntitlements>> | null = null;
  try {
    entitlements = await getEntitlements(db, scope.orgId);
  } catch {
    console.warn('entitlements_load_failed', { orgId: scope.orgId });
  }

  const graphRetrieval =
    entitlements && typeof entitlements.graph_retrieval === 'boolean'
      ? entitlements.graph_retrieval
      : true;
  const ceAllowed =
    entitlements && typeof entitlements.cross_encoder_reranking === 'boolean'
      ? entitlements.cross_encoder_reranking
      : true;
  const maxGraphDepth =
    entitlements && typeof entitlements.max_graph_depth === 'number'
      ? entitlements.max_graph_depth
      : MAX_DEPTH;

  const effectiveMaxDepth = maxGraphDepth > 0 ? Math.min(MAX_DEPTH, maxGraphDepth) : 0;
  let graphEnabled = graphRetrieval && query.graph;
  if (effectiveMaxDepth === 0) graphEnabled = false;

  // Stage 2 — start embedding as a shared promise (semantic + graph await it).
  const embedPromise = embedder.embed(query.text, { mode: 'search' });

  // Stage 3 — four signals in parallel.
  const [semanticResults, keywordResults, graphResults, temporalResults] =
    await Promise.all([
      (async (): Promise<RankedCandidate[]> => {
        const { vector } = await embedPromise;
        return semanticSearch(db, vector, scope.spaceId, query.candidatePool);
      })(),
      keywordSearch(query.text, db, scope.spaceId, query.candidatePool),
      (async (): Promise<RankedCandidate[]> => {
        if (!graphEnabled) return [];
        if (candidates.memories.length === 0 || candidates.entities.length === 0) {
          return [];
        }
        const { vector } = await embedPromise;
        return graphSearchWithStore(
          db,
          query.text,
          vector,
          candidates.memories,
          candidates.entities,
          candidates.memoryToEntities,
          query.candidatePool,
          temporalRange ? temporalRange[1] : null,
          effectiveMaxDepth,
          scope.orgId,
          scope.spaceId,
        );
      })(),
      (async (): Promise<RankedCandidate[]> => {
        if (temporalRange === null) return [];
        return temporalSearch(
          candidates.memories,
          temporalRange[0],
          temporalRange[1],
          Math.min(query.candidatePool, TEMPORAL_CANDIDATE_LIMIT),
        );
      })(),
    ]);

  // Stage 4 — assemble ranked lists (order preserved) + RRF.
  const rankedLists: Array<[SourceSignal, RankedCandidate[]]> = [
    [SourceSignal.SEMANTIC, semanticResults],
    [SourceSignal.KEYWORD, keywordResults],
    [SourceSignal.GRAPH, graphResults],
  ];
  if (temporalResults.length > 0) {
    rankedLists.push([SourceSignal.TEMPORAL, temporalResults]);
  }

  let ceEnabled = reranker !== null && ceAllowed && query.rerank;

  const selectorFused = reciprocalRankFusion(rankedLists);
  const fallbackFused = selectorFused;

  const candidateLookup = new Map<number, RankedCandidate>();
  const sourceSignalsMap = new Map<number, SourceSignal[]>();
  for (const [signal, cands] of rankedLists) {
    for (const candidate of cands) {
      const sigs = sourceSignalsMap.get(candidate.memoryId);
      if (sigs) sigs.push(signal);
      else sourceSignalsMap.set(candidate.memoryId, [signal]);

      const existing = candidateLookup.get(candidate.memoryId);
      if (existing === undefined || candidate.score > existing.score) {
        candidateLookup.set(candidate.memoryId, candidate);
      }
    }
  }

  // Stage 5 — attach source text for the top candidates. Non-fatal: on failure
  // candidates keep source=null (worker.md error-parity table).
  if (candidateLookup.size > 0) {
    try {
      await attachSourceText(db, scope.orgId, candidateLookup);
    } catch {
      console.warn('source_text_attach_failed', { orgId: scope.orgId });
    }
  }

  // Stage 6 — base scores (CE rerank OR rank-remap fallback).
  let baseScores = new Map<number, number>();
  if (ceEnabled) {
    const selection: RankedCandidate[] = [];
    for (const [mid] of selectorFused.slice(0, RERANKER_MAX_CANDIDATES)) {
      const c = candidateLookup.get(mid);
      if (c) selection.push(c);
    }
    try {
      baseScores = await rerankCandidates(reranker!, query.text, selection);
      if (baseScores.size === 0) ceEnabled = false;
    } catch {
      console.warn('ce_failed_falling_back_to_rrf', { orgId: scope.orgId });
      ceEnabled = false;
    }
  }
  if (!ceEnabled) {
    baseScores = rankRemap(fallbackFused);
  }

  // Stage 7 — recency alpha + pool + optional temporal filter.
  const recencyAlpha =
    query.recencyBias !== null
      ? query.recencyBias
      : ceEnabled
        ? RECENCY_ALPHA
        : RECENCY_ALPHA_FALLBACK;

  let pool: Array<[number, number]> = ceEnabled
    ? selectorFused.slice(0, RERANKER_MAX_CANDIDATES)
    : fallbackFused;

  if (temporalRange !== null) {
    const [start, end] = temporalRange;
    const filtered: Array<[number, number]> = [];
    for (const [mid, fscore] of pool) {
      const ranked = candidateLookup.get(mid);
      if (ranked === undefined) continue;
      const ref = ranked.eventTime ?? ranked.recordedAt ?? ranked.createdAt;
      if (ref === null) continue;
      if (start <= ref && ref <= end) filtered.push([mid, fscore]);
    }
    if (filtered.length > 0) pool = filtered;
  }

  // Stage 8 — final score per candidate.
  const scored: CandidateMemory[] = [];
  for (const [memoryId, fusedScore] of pool) {
    const ranked = candidateLookup.get(memoryId);
    if (ranked === undefined) continue;
    const base = baseScores.get(memoryId);
    if (base === undefined) continue;

    const persistence = computePersistence(
      ranked.importanceScore,
      ranked.createdAt,
      ranked.accessFrequency,
      ranked.lastAccessedAt,
    );
    const recency = computeRecency(ranked.createdAt, ranked.recordedAt, ranked.eventTime);
    const recencyFactor = recencyAlpha * (recency - RECENCY_CENTER);

    let totalBoost: number;
    if (temporalRange !== null) {
      const tp = temporalProximityScore(
        ranked.eventTime ?? ranked.recordedAt ?? ranked.createdAt,
        temporalRange[0],
        temporalRange[1],
      );
      const temporalFactor = TEMPORAL_PROXIMITY_ALPHA * (tp - TEMPORAL_CENTER);
      totalBoost = temporalFactor + 0.5 * recencyFactor;
    } else {
      totalBoost = recencyFactor;
    }
    totalBoost = clamp(totalBoost, BOOST_MIN, BOOST_MAX);
    const finalScore = base * (1.0 + totalBoost);

    scored.push({
      memoryId,
      content: ranked.content,
      memoryType: ranked.memoryType,
      orgId: ranked.orgId,
      spaceId: ranked.spaceId,
      importanceScore: ranked.importanceScore,
      createdAt: ranked.createdAt,
      recordedAt: ranked.recordedAt,
      accessFrequency: ranked.accessFrequency,
      lastAccessedAt: ranked.lastAccessedAt,
      eventTime: ranked.eventTime,
      sourceSignals: sourceSignalsMap.get(memoryId) ?? [],
      sourceChunk: ranked.sourceChunk,
      sourceId: ranked.sourceId,
      fusedScore,
      persistenceScore: persistence,
      finalScore,
    });
  }

  // Stage 9 — sort + select top_k (or MMR).
  scored.sort((a, b) => b.finalScore - a.finalScore);

  let top: CandidateMemory[];
  if (query.diversify) {
    const embeddingsLookup = new Map<number, number[]>();
    for (const m of candidates.memories) {
      if (m.embedding !== null) embeddingsLookup.set(m.id, m.embedding);
    }
    top = mmrRerank(scored, embeddingsLookup, query.topK);
  } else {
    top = scored.slice(0, query.topK);
  }

  // Stage 10 — touch (access-frequency bookkeeping) is a write side-effect. It
  // is intentionally NOT done here: the route schedules it off the critical
  // path via `waitUntil` so it doesn't add latency to the response. The
  // access-frequency feedback loop is preserved (it still runs, just async).
  return { query, candidates: top };
}
