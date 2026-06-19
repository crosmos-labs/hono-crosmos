/**
 * Retrieval orchestrator — port of `RetrievalService.retrieve`
 * (`app/engine/retrieval/service.py`). This is the spine: the 10-stage order
 * and scoring assembly below ARE the ranking. See .codex/pipelines.md.
 * Runs inline in the API worker.
 */
import {
  EmbeddingRequestError,
  RerankerRequestError,
  type Embedder,
  type Reranker,
} from '@crosmos/ai';
import type { Database } from '@crosmos/db';
import type { VectorStore } from '@crosmos/vector';
import { durationMs, type Logger } from '@crosmos/observability';
import type { TenantScope } from '@crosmos/types';
import { attachSourceText, type RetrievalCandidates } from './candidates';
import {
  BOOST_MAX,
  BOOST_MIN,
  MAX_DEPTH,
  RECENCY_ALPHA,
  RECENCY_ALPHA_FALLBACK,
  RECENCY_CENTER,
  RERANK_RELEVANCE_FLOOR,
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
import { type Entitlements, getEntitlements } from '../orgs/entitlements';
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
  vectorStore: VectorStore;
}

export interface RetrieveInput {
  query: RetrievalQuery;
  scope: TenantScope;
  candidates: RetrievalCandidates;
  deps: RetrieveDeps;
  /**
   * Pre-fetched org entitlements (the route fetches once per request and
   * shares it with the rate-limit + quota gates). If the property is omitted
   * entirely, the orchestrator fetches its own (back-compat / standalone use).
   * Pass `null` to mean "load failed, use defaults".
   */
  entitlements?: Entitlements | null;
  logger?: Logger;
  /**
   * Optional pre-started query embedding. The route kicks this off BEFORE the
   * visibility + working-set DB loads so the external embedding call (~370ms)
   * overlaps those round-trips instead of running after them. If omitted,
   * retrieve embeds lazily as before. Quality-neutral: identical vector + usage.
   */
  embedPromise?: ReturnType<Embedder['embed']>;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function failureFields(err: unknown): {
  error_category: 'external_service' | 'internal';
  dependency: 'embedding' | 'reranker' | 'database' | 'retrieval';
} {
  if (err instanceof EmbeddingRequestError) {
    return { error_category: 'external_service', dependency: 'embedding' };
  }
  if (err instanceof RerankerRequestError) {
    return { error_category: 'external_service', dependency: 'reranker' };
  }
  return { error_category: 'internal', dependency: 'retrieval' };
}

export async function retrieve(input: RetrieveInput): Promise<RetrievalResult> {
  const { query, scope, candidates, deps } = input;
  const { db, embedder, reranker, vectorStore } = deps;
  const logger = input.logger;

  // Visible working set, keyed by id — the semantic signal resolves ANN hits
  // against this (which enforces visibility), and it's reused for graph below.
  const memoryById = new Map(candidates.memories.map((m) => [m.id, m]));

  // Stage 0 — temporal range (drives temporal signal, graph as_of, pool filter, boost).
  const temporalParseStart = performance.now();
  const temporalRange = extractTemporalRange(query.text);
  logger?.info('retrieval.stage_completed', {
    stage: 'temporal_parse',
    duration_ms: durationMs(temporalParseStart),
  });

  // Stage 1 — entitlements → feature flags. The route passes pre-fetched
  // entitlements (single fetch per request); only fetch here if the caller
  // didn't provide the property at all. Non-fatal on failure (defaults).
  let entitlements: Entitlements | null;
  if (input.entitlements !== undefined) {
    entitlements = input.entitlements;
  } else {
    entitlements = null;
    try {
      const entitlementStart = performance.now();
      entitlements = await getEntitlements(db, scope.orgId);
      logger?.info('retrieval.stage_completed', {
        stage: 'entitlements',
        duration_ms: durationMs(entitlementStart),
      });
    } catch (err) {
      logger?.warn('retrieval.entitlements_load_failed', {
        stage: 'entitlements',
        error_category: 'internal',
        dependency: 'database',
      }, err);
    }
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

  // Stage 2 — embedding as a shared promise (semantic + graph await it). Prefer
  // the route's pre-started embed (overlaps the DB loads); else embed lazily.
  const embedStart = performance.now();
  const embedSource = input.embedPromise ?? embedder.embed(query.text, { mode: 'search' });
  const embedPromise = embedSource.then(
    (result) => {
      logger?.info('embedding.request_completed', {
        stage: 'retrieval_query_embedding',
        embedding_mode: 'search',
        embedding_count: 1,
        duration_ms: durationMs(embedStart),
        token_count: result.usage.totalTokens,
      });
      return result;
    },
    (err) => {
      logger?.error('embedding.request_failed', {
        stage: 'retrieval_query_embedding',
        embedding_mode: 'search',
        embedding_count: 1,
        duration_ms: durationMs(embedStart),
        ...failureFields(err),
      }, err);
      throw err;
    },
  );

  // Stage 3 — four signals in parallel.
  const [semanticResults, keywordResults, graphResults, temporalResults] =
    await Promise.all([
      timeSignal(logger, SourceSignal.SEMANTIC, async (): Promise<RankedCandidate[]> => {
        const { vector } = await embedPromise;
        return semanticSearch(vectorStore, vector, scope, query.candidatePool, memoryById);
      }),
      timeSignal(logger, SourceSignal.KEYWORD, () =>
        keywordSearch(query.text, db, scope, query.candidatePool),
      ),
      timeSignal(logger, SourceSignal.GRAPH, async (): Promise<RankedCandidate[]> => {
        if (!graphEnabled) return [];
        if (candidates.memories.length === 0 || candidates.entities.length === 0) {
          return [];
        }
        const { vector } = await embedPromise;
        return graphSearchWithStore(
          db,
          vectorStore,
          query.text,
          vector,
          candidates.memories,
          candidates.entities,
          candidates.memoryToEntities,
          query.candidatePool,
          temporalRange ? temporalRange[1] : null,
          effectiveMaxDepth,
          scope,
        );
      }),
      timeSignal(logger, SourceSignal.TEMPORAL, async (): Promise<RankedCandidate[]> => {
        if (temporalRange === null) return [];
        return temporalSearch(
          candidates.memories,
          temporalRange[0],
          temporalRange[1],
          Math.min(query.candidatePool, TEMPORAL_CANDIDATE_LIMIT),
        );
      }),
    ]);

  // Stage 4 — assemble ranked lists (order preserved) + RRF.
  const fusionStart = performance.now();
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
  logger?.info('retrieval.stage_completed', {
    stage: 'fusion',
    duration_ms: durationMs(fusionStart),
    candidate_count: selectorFused.length,
    graph_enabled: graphEnabled,
  });

  const lookupStart = performance.now();
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
  logger?.info('retrieval.stage_completed', {
    stage: 'candidate_lookup',
    duration_ms: durationMs(lookupStart),
    candidate_count: candidateLookup.size,
  });

  // Stage 5 — attach source text for the top candidates, CONCURRENTLY with the
  // Stage-6 reranker below. The two are independent: the reranker scores each
  // candidate's `content`, while attach only fills the `source`/`sourceId`
  // fields that are first read at Stage 8. Starting it here (instead of awaiting
  // before rerank) hides the ~120ms citation round-trip behind the ~280ms
  // rerank. Non-fatal and never rejects: on failure candidates keep source=null
  // (worker.md error-parity table). Awaited just before Stage 8.
  let attachPromise: Promise<void> = Promise.resolve();
  if (candidateLookup.size > 0) {
    const attachSourceStart = performance.now();
    attachPromise = attachSourceText(db, scope, candidateLookup).then(
      () => {
        logger?.info('retrieval.stage_completed', {
          stage: 'source_text_attach',
          duration_ms: durationMs(attachSourceStart),
          candidate_count: candidateLookup.size,
        });
      },
      (err) => {
        logger?.warn('retrieval.source_text_attach_failed', {
          stage: 'source_text_attach',
          duration_ms: durationMs(attachSourceStart),
          error_category: 'internal',
          dependency: 'database',
        }, err);
      },
    );
  }

  // Stage 6 — base scores (CE rerank OR rank-remap fallback).
  let baseScores = new Map<number, number>();
  if (ceEnabled) {
    const rerankStart = performance.now();
    const selection: RankedCandidate[] = [];
    for (const [mid] of selectorFused.slice(0, RERANKER_MAX_CANDIDATES)) {
      const c = candidateLookup.get(mid);
      if (c) selection.push(c);
    }
    try {
      baseScores = await rerankCandidates(reranker!, query.text, selection);
      if (baseScores.size === 0) ceEnabled = false;
      logger?.info('retrieval.stage_completed', {
        stage: 'rerank',
        duration_ms: durationMs(rerankStart),
        candidate_count: selection.length,
        result_count: baseScores.size,
        ce_enabled: ceEnabled,
      });
    } catch (err) {
      logger?.warn('retrieval.rerank_failed_falling_back', {
        stage: 'rerank',
        duration_ms: durationMs(rerankStart),
        candidate_count: selection.length,
        ...failureFields(err),
      }, err);
      ceEnabled = false;
    }
  }
  if (!ceEnabled) {
    const rankRemapStart = performance.now();
    baseScores = rankRemap(fallbackFused);
    logger?.info('retrieval.stage_completed', {
      stage: 'rank_remap',
      duration_ms: durationMs(rankRemapStart),
      candidate_count: fallbackFused.length,
      result_count: baseScores.size,
      ce_enabled: false,
    });
  }

  // Join the concurrent Stage-5 source-text attach before Stage 8 reads
  // sourceChunk/sourceId off the candidates. (Never rejects — see Stage 5.)
  await attachPromise;

  // Stage 7 — recency alpha + pool + optional temporal filter.
  const scoringStart = performance.now();
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
      ownerUserId: ranked.ownerUserId,
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
      sourceUuid: ranked.sourceUuid,
      sessionId: ranked.sessionId,
      fusedScore,
      persistenceScore: persistence,
      finalScore,
      rerankScore: base,
      ceRelevance: ceEnabled,
    });
  }

  // Stage 9 — sort, apply the rerank relevance floor, then select top_k (or MMR).
  scored.sort((a, b) => b.finalScore - a.finalScore);

  // Post-rerank precision gate: when the cross-encoder is active, drop weakly
  // relevant candidates so the reader sees only on-topic memories. Always keep
  // at least the single best candidate — a weak query returns fewer, never zero.
  let selectable = scored;
  if (ceEnabled && scored.length > 0) {
    const aboveFloor = scored.filter((c) => c.rerankScore >= RERANK_RELEVANCE_FLOOR);
    selectable = aboveFloor.length > 0 ? aboveFloor : scored.slice(0, 1);
    if (selectable.length !== scored.length) {
      logger?.info('retrieval.stage_completed', {
        stage: 'rerank_floor',
        candidate_count: scored.length,
        result_count: selectable.length,
        floor: RERANK_RELEVANCE_FLOOR,
      });
    }
  }

  let top: CandidateMemory[];
  if (query.diversify) {
    // MMR needs raw vectors for the scored pool. Pull them from the vector
    // store (pg: column read; vectorize: batched getByIds).
    const embeddingsLookup = await vectorStore.fetchVectors(
      'memories',
      selectable.map((c) => c.memoryId),
    );
    top = mmrRerank(selectable, embeddingsLookup, query.topK);
  } else {
    top = selectable.slice(0, query.topK);
  }
  logger?.info('retrieval.stage_completed', {
    stage: 'score_and_select',
    duration_ms: durationMs(scoringStart),
    candidate_count: scored.length,
    result_count: top.length,
    top_k: query.topK,
  });

  // Stage 10 — touch (access-frequency bookkeeping) is a write side-effect. It
  // is intentionally NOT done here: the route schedules it off the critical
  // path via `waitUntil` so it doesn't add latency to the response. The
  // access-frequency feedback loop is preserved (it still runs, just async).
  return { query, candidates: top };
}

async function timeSignal(
  logger: Logger | undefined,
  signal: SourceSignal,
  fn: () => Promise<RankedCandidate[]>,
): Promise<RankedCandidate[]> {
  const start = performance.now();
  try {
    const results = await fn();
    logger?.info('retrieval.signal_completed', {
      signal,
      duration_ms: durationMs(start),
      result_count: results.length,
    });
    return results;
  } catch (err) {
    logger?.error('retrieval.signal_failed', {
      signal,
      duration_ms: durationMs(start),
      ...failureFields(err),
    }, err);
    throw err;
  }
}
