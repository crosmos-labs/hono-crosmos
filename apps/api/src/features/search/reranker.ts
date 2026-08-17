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

const CURRENT_INFORMATION_QUERY = /\b(current|currently|latest|now|most recent|still|today)\b/i;
const CURRENT_INFORMATION_INSTRUCTION =
  'Instruction: For current or latest information, prefer a document with a later [Recorded: ...] date when it explicitly updates, replaces, or corrects an older fact. Do not prefer a document merely because it is newer.';

function formatDate(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${MONTHS[date.getUTCMonth()]} ${dd}, ${yyyy} (${yyyy}-${mm}-${dd})`;
}

/**
 * Build the document string for a candidate. Event dates retain the legacy
 * Python format. Voyage additionally receives the source's recorded date so
 * it can distinguish later corrections from older, otherwise-equivalent
 * memories when the query asks for current information.
 */
export function formatDoc(
  candidate: RankedCandidate,
  includeRecordedAt = false,
): string {
  const parts: string[] = [];
  if (candidate.eventTime !== null) {
    parts.push(`[Date: ${formatDate(candidate.eventTime)}]`);
  }
  if (includeRecordedAt) {
    parts.push(`[Recorded: ${formatDate(candidate.recordedAt)}]`);
  }
  parts.push(candidate.content);
  return parts.join(' ');
}

/** Add Voyage's supported natural-language ranking instruction when needed. */
export function formatQuery(reranker: Reranker, query: string): string {
  if (
    reranker.defaultModel.startsWith('rerank-2.5')
    && CURRENT_INFORMATION_QUERY.test(query)
  ) {
    return `${CURRENT_INFORMATION_INSTRUCTION}\nQuery: ${query}`;
  }
  return query;
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

  const includeRecordedAt = reranker.defaultModel.startsWith('rerank-2.5');
  const documents = candidates.map((candidate) => formatDoc(candidate, includeRecordedAt));
  const results = await reranker.rerank(formatQuery(reranker, query), documents, { signal });

  for (const { index, score } of results) {
    const candidate = candidates[index];
    if (candidate === undefined) continue; // defensive: bad index from provider
    const clamped = Number.isNaN(score) ? 0.0 : Math.max(0.0, Math.min(1.0, score));
    result.set(candidate.memoryId, clamped);
  }
  return result;
}
