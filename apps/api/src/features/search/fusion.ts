/**
 * Fusion & scoring — verbatim port of `app/engine/retrieval/fusion.py` plus
 * the rank-remap from `service.py`. These formulas ARE the ranking. See
 * .codex/pipelines.md.
 */
import {
  ALPHA,
  D,
  LAMBDA,
  MIN_RECENCY_GAP_DAYS,
  MMR_LAMBDA,
  MMR_MIN_RELEVANCE,
  RECENCY_FLOOR,
  RRF_K,
  SIGMA,
  SOURCE_WEIGHTS,
} from './constants';
import type { CandidateMemory, RankedCandidate, SourceSignal } from './types';
import { cosineSimilarity } from './vector';

const SEC_PER_DAY = 86400;
const CURRENT_INFORMATION_QUERY =
  /\b(current|currently|latest|now|most recent|still|today)\b/i;
const EXPLICIT_UPDATE_MEMORY =
  /\b(changed?|correct(?:ed|s)?|no longer|now|replac(?:ed|es)|remain(?:s|ed)|still|instead|updat(?:ed|es?))\b/i;
const STILL_CONFIRMATION_QUERY =
  /^(?:am|are|can|could|did|do|does|has|have|is|was|were|will|would)\b.*\bstill\b/i;

const EXPLICIT_REVISION_BONUS = 0.15;
const UNREVISED_CONFIRMATION_PENALTY = -0.25;

/**
 * Recorded dates are useful evidence only when both sides establish temporal
 * intent: the query asks for the current value and the memory describes an
 * explicit update. This avoids making newly imported, old facts look fresh.
 */
export function shouldUseRecordedRecency(query: string, content: string): boolean {
  return CURRENT_INFORMATION_QUERY.test(query) && EXPLICIT_UPDATE_MEMORY.test(content);
}

/**
 * A yes/no “still?” query is asking whether an older proposition survived.
 * Exact lexical matching otherwise favors the old proposition itself. Prefer
 * memories that explicitly revise or reaffirm it, and demote bare historical
 * assertions. The narrow query shape keeps this out of ordinary fact lookup.
 */
export function computeRevisionAdjustment(query: string, content: string): number {
  if (!STILL_CONFIRMATION_QUERY.test(query)) return 0;
  return EXPLICIT_UPDATE_MEMORY.test(content)
    ? EXPLICIT_REVISION_BONUS
    : UNREVISED_CONFIRMATION_PENALTY;
}

/**
 * Reciprocal Rank Fusion — candidate selector. `ranked_lists` is an ordered
 * list of `[signal, candidates]`; iteration order is preserved so equal-score
 * ties break by first-seen memory (matches Python's defaultdict insertion
 * order + stable sort). Returns `[memoryId, rrfScore]` sorted desc.
 */
export function reciprocalRankFusion(
  rankedLists: Array<[SourceSignal, RankedCandidate[]]>,
  k: number = RRF_K,
): Array<[number, number]> {
  // Map preserves first-seen insertion order, like Python's defaultdict.
  const scores = new Map<number, number>();
  for (const [source, candidates] of rankedLists) {
    const weight = SOURCE_WEIGHTS[source] ?? 1.0;
    for (const c of candidates) {
      scores.set(c.memoryId, (scores.get(c.memoryId) ?? 0) + weight / (k + c.rank));
    }
  }
  // Stable sort by score desc (V8 Array.sort is stable → ties keep first-seen).
  return [...scores.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * RRF-fallback rank remap (service.py, CE off/failed). RRF scores are too flat
 * (~0.03–0.04) for multiplicative boosts to reorder, so map rank → [0.1, 1.0].
 * Rank 0 → 1.0; last rank → 0.1.
 */
export function rankRemap(fallbackFused: Array<[number, number]>): Map<number, number> {
  const sorted = [...fallbackFused].sort((a, b) => b[1] - a[1]);
  const n = sorted.length;
  const denom = Math.max(1, n - 1);
  const out = new Map<number, number>();
  sorted.forEach(([memoryId], rank) => {
    out.set(memoryId, 1.0 - (0.9 * rank) / denom);
  });
  return out;
}

/**
 * Linear recency decay over 365 days. Uses `event_time` by default. A caller
 * may explicitly opt an update memory into its recorded date for a current-
 * information query; all other undated memories remain neutral at 0.5.
 * Floor 0.2, ceil 1.0.
 */
export function computeRecency(
  _createdAt: Date,
  recordedAt: Date | null,
  eventTime: Date | null,
  now: Date = new Date(),
  useRecordedAt = false,
): number {
  const reference = eventTime ?? (useRecordedAt ? recordedAt : null);
  if (reference !== null) {
    const ageDays = (now.getTime() - reference.getTime()) / 1000 / SEC_PER_DAY;
    return Math.max(RECENCY_FLOOR, Math.min(1.0, 1.0 - ageDays / 365.0));
  }
  return 0.5;
}

/** Intrinsic decay + access-frequency reinforcement. Clamped [0, 1]. */
export function computePersistence(
  importanceScore: number | null,
  createdAt: Date,
  accessFrequency: number,
  lastAccessedAt: Date,
  now: Date = new Date(),
): number {
  const sImp = importanceScore ?? 0.5;
  const deltaT = (now.getTime() - createdAt.getTime()) / 1000 / SEC_PER_DAY;
  const intrinsic = sImp * Math.exp(-LAMBDA * deltaT);

  let reinforcement: number;
  if (accessFrequency === 0) {
    reinforcement = 0.0;
  } else {
    const recencyGap = Math.max(
      (now.getTime() - lastAccessedAt.getTime()) / 1000 / SEC_PER_DAY,
      MIN_RECENCY_GAP_DAYS,
    );
    reinforcement =
      (SIGMA * Math.pow(accessFrequency, ALPHA)) / (1.0 + Math.pow(recencyGap, D));
  }

  return Math.max(0.0, Math.min(1.0, intrinsic + reinforcement));
}

/**
 * Pairwise-max MMR diversity filter, applied post-rerank / pre-top-K. Greedily
 * selects the candidate maximising `λ·relevance − (1−λ)·max_sim_to_selected`.
 * Relevance is final_score normalised to the top candidate. Candidates without
 * an embedding are treated as maximally dissimilar. Tie-break: higher
 * final_score.
 */
export function mmrRerank(
  candidates: CandidateMemory[],
  embeddings: Map<number, number[]>,
  topK: number,
  lambda: number = MMR_LAMBDA,
): CandidateMemory[] {
  if (candidates.length === 0 || topK <= 0) return [];

  const maxScore = Math.max(...candidates.map((c) => c.finalScore)) || 1.0;

  const remaining = [...candidates];
  const selected: CandidateMemory[] = [];
  const selectedEmbeddings: number[][] = [];

  while (remaining.length > 0 && selected.length < topK) {
    let best: CandidateMemory | null = null;
    let bestMmr = Number.NEGATIVE_INFINITY;

    for (const c of remaining) {
      const relevance = c.finalScore / maxScore;
      if (relevance < MMR_MIN_RELEVANCE) continue;
      const emb = embeddings.get(c.memoryId);
      let maxSim: number;
      if (emb === undefined || selectedEmbeddings.length === 0) {
        maxSim = 0.0;
      } else {
        maxSim = Math.max(
          0.0,
          Math.max(...selectedEmbeddings.map((s) => cosineSimilarity(emb, s))),
        );
      }
      const mmr = lambda * relevance - (1.0 - lambda) * maxSim;
      if (mmr > bestMmr || (mmr === bestMmr && best !== null && c.finalScore > best.finalScore)) {
        bestMmr = mmr;
        best = c;
      }
    }

    if (best === null) break;
    selected.push(best);
    const emb = embeddings.get(best.memoryId);
    if (emb !== undefined) selectedEmbeddings.push(emb);
    remaining.splice(remaining.indexOf(best), 1);
  }

  return selected;
}
