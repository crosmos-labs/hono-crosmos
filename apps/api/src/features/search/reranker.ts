/**
 * Cross-encoder reranking — port of `app/engine/retrieval/reranker.py`, bridged
 * to our `@crosmos/ai` `Reranker` interface.
 *
 * Two contract differences from Python (decisions.md §3):
 *   - Python's `predict(pairs) -> list[float]` returns scores in INPUT order;
 *     our `rerank(query, docs) -> {index, score}[]` returns sorted by score.
 *     We map results back by `index` — never assume order.
 *   - After scoring: NaN → 0, then clamp to [0, 1].
 * Empty candidate list → empty map, no network call.
 */
import type { Reranker } from '@crosmos/ai';
import type { RankedCandidate } from './types';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Build the document string for a candidate. If `event_time` is set, prefix
 * `"[Date: {Month DD, YYYY} ({YYYY-MM-DD})] "` (timezone-naive → UTC). Matches
 * Python's `strftime("%B %d, %Y")` / `strftime("%Y-%m-%d")` exactly.
 */
export function formatDoc(candidate: RankedCandidate): string {
  const parts: string[] = [];
  const date = candidate.eventTime;
  if (date !== null) {
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    const iso = `${yyyy}-${mm}-${dd}`;
    const readable = `${MONTHS[date.getUTCMonth()]} ${dd}, ${yyyy}`;
    parts.push(`[Date: ${readable} (${iso})]`);
  }
  parts.push(candidate.content);
  return parts.join(' ');
}

/** Score candidates with the cross-encoder → `{memoryId: clamped score}`. */
export async function rerankCandidates(
  reranker: Reranker,
  query: string,
  candidates: RankedCandidate[],
  signal?: AbortSignal,
): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  if (candidates.length === 0) return result;

  const documents = candidates.map(formatDoc);
  const results = await reranker.rerank(query, documents, { signal });

  for (const { index, score } of results) {
    const candidate = candidates[index];
    if (candidate === undefined) continue; // defensive: bad index from provider
    const clamped = Number.isNaN(score) ? 0.0 : Math.max(0.0, Math.min(1.0, score));
    result.set(candidate.memoryId, clamped);
  }
  return result;
}
