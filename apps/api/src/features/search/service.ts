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
import { durationMs, type Logger, type Metrics } from '@crosmos/observability';
import type { TenantScope } from '@crosmos/types';
import { attachCandidateProvenance, attachSourceContent } from './candidates';
import {
  BOOST_MAX,
  BOOST_MIN,
  MAX_DEPTH,
  RECENCY_ALPHA,
  RECENCY_ALPHA_FALLBACK,
  RECENCY_CENTER,
  RERANK_RELEVANCE_FLOOR,
  RERANKER_MAX_CANDIDATES,
  SESSION_DIVERSITY_PENALTY,
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
   * visibility resolution so the external embedding call (~370ms) overlaps that
   * round-trip and the signals' bounded DB queries instead of running after
   * them. If omitted, retrieve embeds lazily as before. Quality-neutral:
   * identical vector + usage.
   */
  embedPromise?: ReturnType<Embedder['embed']>;
  /**
   * Request deadline. Forwarded to every cancellable downstream call (embedder,
   * vector store, reranker) and checked between stages, so a search the client
   * has already been told timed out stops consuming provider and connection
   * capacity instead of running invisibly to completion.
   *
   * Optional: omitted, retrieval behaves exactly as before.
   */
  signal?: AbortSignal;
  /**
   * Optional metrics sink. Only bounded-cardinality dimensions are tagged —
   * signal name, ok/failed, a reason enum. Never ids, never the query.
   */
  metrics?: Metrics;
}

/**
 * True once the request deadline has passed. Checked BETWEEN stages, because
 * aborting an in-flight fetch is necessary but not sufficient: without this the
 * next stage would simply start a brand-new one on a request nobody is waiting
 * for any more.
 */
function expired(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Session-diversified top-K selection. Greedily pick the highest-scoring
 * candidate after subtracting `SESSION_DIVERSITY_PENALTY * n`, where `n` is how
 * many already-selected results share the candidate's source session. This
 * spreads the top-K across DISTINCT sessions (the multi-session aggregation axis)
 * so one on-query cluster can't monopolise it and drop other gold sessions —
 * while a far-more-relevant same-session memory still wins (single-session
 * questions keep their dominant session). Input MUST be pre-sorted by finalScore
 * desc. O(topK · N); N ≤ RERANKER_MAX_CANDIDATES. Penalty 0 ⇒ plain slice.
 */
function selectSessionDiverse(scored: CandidateMemory[], topK: number): CandidateMemory[] {
  if (SESSION_DIVERSITY_PENALTY <= 0 || scored.length <= topK) {
    return scored.slice(0, topK);
  }
  const remaining = [...scored];
  const selected: CandidateMemory[] = [];
  const perSession = new Map<string, number>();
  // A null session must NOT group with other null sessions (each is its own
  // distinct source), so key those by memoryId.
  const sessionKey = (c: CandidateMemory): string =>
    c.sessionId ?? `__nosession_${c.memoryId}`;
  while (selected.length < topK && remaining.length > 0) {
    let bestIdx = 0;
    let bestAdj = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i]!;
      const used = perSession.get(sessionKey(c)) ?? 0;
      const adj = c.finalScore - SESSION_DIVERSITY_PENALTY * used;
      if (adj > bestAdj) {
        bestAdj = adj;
        bestIdx = i;
      }
    }
    const picked = remaining.splice(bestIdx, 1)[0]!;
    perSession.set(sessionKey(picked), (perSession.get(sessionKey(picked)) ?? 0) + 1);
    selected.push(picked);
  }
  return selected;
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
  const { query, scope, deps } = input;
  const { db, embedder, reranker, vectorStore } = deps;
  const logger = input.logger;

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
  const embedSource =
    input.embedPromise ?? embedder.embed(query.text, { mode: 'search', signal: input.signal });
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
  //
  // `allSettled`, not `all`: a rejection in ONE auxiliary signal used to reject
  // the whole fan-out and surface as a 500. That is how five `tsquery stack too
  // small` errors from the keyword signal — an input-shape problem in one of
  // four ranking inputs — failed entire searches during the 2026-07-25 incident.
  //
  // Policy (see `unwrapSignals`): semantic is essential, the rest are auxiliary.
  const settledSignals = await Promise.allSettled([
    timeSignal(logger, SourceSignal.SEMANTIC, async (): Promise<RankedCandidate[]> => {
      const { vector } = await embedPromise;
      return semanticSearch(db, vectorStore, vector, scope, query.candidatePool, input.signal);
    }),
    timeSignal(logger, SourceSignal.KEYWORD, () =>
      keywordSearch(query.text, db, scope, query.candidatePool),
    ),
    timeSignal(logger, SourceSignal.GRAPH, async (): Promise<RankedCandidate[]> => {
      if (!graphEnabled) return [];
      const { vector } = await embedPromise;
      return graphSearchWithStore(
        db,
        vectorStore,
        query.text,
        vector,
        scope,
        query.candidatePool,
        temporalRange ? temporalRange[1] : null,
        effectiveMaxDepth,
        {
          signal: input.signal,
          // Observational only — this is the last unbounded read in the graph
          // signal and we need its real distribution before deciding whether a
          // cap is safe (a cap would change graph recall).
          onSeedFanout: ({ seedEntityCount, memoryCount }) =>
            logger?.info('retrieval.graph_seed_fanout', {
              signal: SourceSignal.GRAPH,
              entity_count: seedEntityCount,
              memory_count: memoryCount,
            }),
        },
      );
    }),
    timeSignal(logger, SourceSignal.TEMPORAL, async (): Promise<RankedCandidate[]> => {
      if (temporalRange === null) return [];
      return temporalSearch(
        db,
        scope,
        temporalRange[0],
        temporalRange[1],
        Math.min(query.candidatePool, TEMPORAL_CANDIDATE_LIMIT),
      );
    }),
  ]);
  const [semanticResults, keywordResults, graphResults, temporalResults] =
    unwrapSignals(settledSignals, logger);

  // Per-signal health. A signal quietly returning zero candidates looks
  // identical to "nothing matched" in the response, so without this a
  // degraded-but-not-failing signal (a red vector store, a bad tsquery shape) is
  // invisible until recall quality complains.
  const signalNames = [
    SourceSignal.SEMANTIC,
    SourceSignal.KEYWORD,
    SourceSignal.GRAPH,
    SourceSignal.TEMPORAL,
  ];
  const signalResults = [semanticResults, keywordResults, graphResults, temporalResults];
  settledSignals.forEach((settled, i) => {
    input.metrics?.count('retrieval_signal', {
      tags: [signalNames[i]!, settled.status === 'fulfilled' ? 'ok' : 'failed'],
      values: [signalResults[i]!.length],
      index: 'retrieval_signal',
    });
  });

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

  // Stage 5 — attach candidate PROVENANCE (source id/uuid + session id) for the
  // fused candidates, CONCURRENTLY with the Stage-6 reranker below. The two are
  // independent: the reranker scores each candidate's `content`, while this only
  // fills fields first read at Stage 8 — and `sessionId`, which session-diverse
  // selection needs, so it cannot be deferred past selection. Starting it here
  // (instead of awaiting before rerank) hides the citation round-trip behind the
  // rerank. Non-fatal and never rejects: on failure candidates keep
  // source=null (worker.md error-parity table). Awaited just before Stage 8.
  //
  // Full source TEXT is deliberately not loaded here — see `attachSourceContent`,
  // which runs after selection over only the returned candidates.
  let attachPromise: Promise<void> = Promise.resolve();
  if (candidateLookup.size > 0) {
    const attachSourceStart = performance.now();
    attachPromise = attachCandidateProvenance(db, scope, candidateLookup).then(
      () => {
        logger?.info('retrieval.stage_completed', {
          stage: 'source_provenance_attach',
          duration_ms: durationMs(attachSourceStart),
          candidate_count: candidateLookup.size,
        });
      },
      (err: unknown) => {
        logger?.warn('retrieval.source_text_attach_failed', {
          stage: 'source_provenance_attach',
          duration_ms: durationMs(attachSourceStart),
          error_category: 'internal',
          dependency: 'database',
        }, err);
      },
    );
  }

  // Stage 6 — base scores (CE rerank OR rank-remap fallback).
  //
  // Deadline check before the reranker: it is the most expensive remaining
  // external call, and by this point the signal fan-out has already run. If the
  // client has been told the request timed out, starting a fresh ZeroEntropy
  // call would burn provider capacity for a result nobody will read. Falling
  // through leaves `ceEnabled = false`, which takes the existing rank-remap
  // fallback path — the same well-tested degradation used when the reranker
  // errors, not a new one.
  if (ceEnabled && expired(input.signal)) {
    logger?.warn('retrieval.stage_skipped', {
      stage: 'rerank',
      reason: 'deadline_expired',
    });
    // Distinguishes "the reranker is off" from "we ran out of time before it".
    // A rising rate here means the 6s budget is being consumed upstream.
    input.metrics?.count('retrieval_deadline', {
      tags: ['rerank', 'skipped'],
      index: 'retrieval_deadline',
    });
    ceEnabled = false;
  }

  let baseScores = new Map<number, number>();
  if (ceEnabled) {
    const rerankStart = performance.now();
    const selection: RankedCandidate[] = [];
    for (const [mid] of selectorFused.slice(0, RERANKER_MAX_CANDIDATES)) {
      const c = candidateLookup.get(mid);
      if (c) selection.push(c);
    }
    try {
      baseScores = await rerankCandidates(reranker!, query.text, selection, input.signal);
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
      uuid: ranked.uuid,
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
    top = selectSessionDiverse(selectable, query.topK);
  }
  logger?.info('retrieval.stage_completed', {
    stage: 'score_and_select',
    duration_ms: durationMs(scoringStart),
    candidate_count: scored.length,
    result_count: top.length,
    top_k: query.topK,
  });

  // Stage 9.5 — full source text for the SELECTED candidates only, and only if
  // the caller asked for it. Before this split the raw `sources.content` was
  // pulled for every fused candidate, of which at most `topK` are returned.
  // Bounded by the distinct sources in the final result, so it is a small
  // by-id read. Non-fatal, matching the provenance attach: a failure leaves
  // `source: null` rather than failing the search.
  if (query.includeSource !== false && top.length > 0) {
    const sourceContentStart = performance.now();
    try {
      await attachSourceContent(db, scope, top);
      logger?.info('retrieval.stage_completed', {
        stage: 'source_content_load',
        duration_ms: durationMs(sourceContentStart),
        result_count: top.length,
      });
    } catch (err) {
      logger?.warn('retrieval.source_text_attach_failed', {
        stage: 'source_content_load',
        duration_ms: durationMs(sourceContentStart),
        error_category: 'internal',
        dependency: 'database',
      }, err);
    }
  }

  // Stage 10 — touch (access-frequency bookkeeping) is a write side-effect. It
  // is intentionally NOT done here: the route schedules it off the critical
  // path via `waitUntil` so it doesn't add latency to the response. The
  // access-frequency feedback loop is preserved (it still runs, just async).
  return { query, candidates: top };
}

/** Fan-out order of the Stage-3 signals; indexes into the settled array. */
const SIGNAL_ORDER = [
  SourceSignal.SEMANTIC,
  SourceSignal.KEYWORD,
  SourceSignal.GRAPH,
  SourceSignal.TEMPORAL,
] as const;

/**
 * Turn the settled signal fan-out into four candidate lists, applying the
 * degradation policy.
 *
 * **Semantic is essential; keyword, graph and temporal are auxiliary.** An
 * auxiliary signal that fails contributes an empty ranked list: fusion still has
 * the semantic ordering to work from, so the caller gets a slightly less rich
 * but entirely valid hybrid result instead of a 500. Semantic failing means the
 * embedder or vector store is down — there is no meaningful retrieval left, and
 * returning a keyword-only (or empty) result would quietly hand an agent bad
 * recall it would then answer confidently from. That case still throws, so a
 * genuine dependency outage stays loud and gets classified by the route.
 *
 * Degradation is always recorded. Failing open must not mean failing silently:
 * the per-signal error was already logged by `timeSignal`, and this adds one
 * request-level record naming exactly which signals were lost.
 */
function unwrapSignals(
  settled: Array<PromiseSettledResult<RankedCandidate[]>>,
  logger: Logger | undefined,
): [RankedCandidate[], RankedCandidate[], RankedCandidate[], RankedCandidate[]] {
  const semantic = settled[0]!;
  if (semantic.status === 'rejected') throw semantic.reason;

  const degraded: SourceSignal[] = [];
  const lists = settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    degraded.push(SIGNAL_ORDER[i]!);
    return [] as RankedCandidate[];
  });

  if (degraded.length > 0) {
    logger?.warn('retrieval.signals_degraded', {
      stage: 'signals',
      degraded_signals: degraded,
      degraded_count: degraded.length,
    });
  }

  return lists as [
    RankedCandidate[],
    RankedCandidate[],
    RankedCandidate[],
    RankedCandidate[],
  ];
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
