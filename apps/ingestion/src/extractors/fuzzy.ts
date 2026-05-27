/**
 * Lightweight equivalent of `rapidfuzz.fuzz.token_sort_ratio`.
 *
 * Sorting both inputs' tokens before scoring makes the metric
 * permutation-tolerant: `"Anthropic Inc"` vs `"Inc Anthropic"` scores ~100.
 * The base similarity is Levenshtein-derived:
 *
 *     ratio = (1 - edit_distance / (len(a) + len(b))) * 100
 *
 * `process.extract` returns the top-K matches with scores at or above a cutoff,
 * matching Python's rapidfuzz API closely enough for our use.
 *
 * See .codex/pipelines.md.
 */

/** Standard Levenshtein distance (insert/delete/substitute = 1). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Two-row dynamic programming
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const ins = curr[j - 1]! + 1;
      const del = prev[j]! + 1;
      const sub = prev[j - 1]! + cost;
      curr[j] = Math.min(ins, del, sub);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

function casefoldCollapse(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokenSort(s: string): string {
  const tokens = casefoldCollapse(s).split(' ').filter((t) => t.length > 0);
  tokens.sort();
  return tokens.join(' ');
}

/** Token-sort Levenshtein-based similarity, scaled to [0..100]. */
export function tokenSortRatio(a: string, b: string): number {
  const ta = tokenSort(a);
  const tb = tokenSort(b);
  if (ta.length === 0 && tb.length === 0) return 100;
  if (ta.length === 0 || tb.length === 0) return 0;
  if (ta === tb) return 100;
  const dist = levenshtein(ta, tb);
  const denom = ta.length + tb.length;
  return Math.round((1 - (2 * dist) / denom) * 100);
}

export interface FuzzyMatch<T> {
  choice: T;
  score: number;
}

/**
 * Top-K matches from `choices` for `query`, restricted to scores >= cutoff.
 * Stable sort: higher score first; ties keep input order.
 */
export function fuzzyExtract<T>(
  query: string,
  choices: T[],
  toString: (c: T) => string,
  opts: { limit: number; scoreCutoff: number },
): FuzzyMatch<T>[] {
  const scored: Array<FuzzyMatch<T> & { i: number }> = [];
  for (let i = 0; i < choices.length; i++) {
    const choice = choices[i]!;
    const score = tokenSortRatio(query, toString(choice));
    if (score >= opts.scoreCutoff) scored.push({ choice, score, i });
  }
  scored.sort((a, b) => (b.score - a.score) || (a.i - b.i));
  return scored.slice(0, opts.limit).map(({ choice, score }) => ({ choice, score }));
}
