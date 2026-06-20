import {
  extract,
  token_sort_ratio,
  type FuzzballBaseOptions,
  type FuzzballExtractObjectOptions,
} from 'fuzzball';

const FUZZY_OPTIONS = {
  force_ascii: false,
} satisfies FuzzballBaseOptions;

/** Token-sort Levenshtein-based similarity, scaled to [0..100]. */
export function tokenSortRatio(a: string, b: string): number {
  return token_sort_ratio(a, b, FUZZY_OPTIONS);
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
  getChoiceText: (c: T) => string,
  opts: { limit: number; scoreCutoff: number },
): FuzzyMatch<T>[] {
  const extractOptions = {
    ...FUZZY_OPTIONS,
    scorer: (a, b, scorerOpts) => token_sort_ratio(a, b, scorerOpts),
    processor: (choice) => getChoiceText(choice as T),
    cutoff: opts.scoreCutoff,
    returnObjects: true,
  } satisfies FuzzballExtractObjectOptions;

  const matches = extract(query, choices, extractOptions);

  return matches
    .sort((a, b) => (b.score - a.score) || (a.key - b.key))
    .slice(0, opts.limit)
    .map(({ choice, score }) => ({ choice, score }));
}
