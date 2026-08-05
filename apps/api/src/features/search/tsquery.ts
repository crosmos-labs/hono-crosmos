/**
 * Full-text query bounding for the two call sites that hand user-influenced text
 * to PostgreSQL's `websearch_to_tsquery`.
 *
 * `websearch_to_tsquery` cannot raise a syntax error — that is why it is used —
 * but it CAN still build a tsquery too large for the parser to handle, which
 * PostgreSQL reports as `tsquery stack too small`. That happened five times
 * during the 2026-07-25 incident, and because the signal fan-out was strict at
 * the time, each one failed an entire search.
 *
 * Two independent defenses now exist. The signal fan-out fails soft
 * (`service.ts` → `unwrapSignals`), so a keyword failure degrades rather than
 * 500s; this module stops the query from being pathological in the first place
 * so the degradation is rarely needed.
 *
 * **Quality-neutral by construction.** A query already within the bounds is
 * returned byte-for-byte unchanged, so normal traffic keeps exactly today's
 * ranking — including phrase quoting and the `or`/`-` operators
 * `websearch_to_tsquery` understands, which a rewrite would destroy. Only input
 * that exceeds a bound is touched, and then only by truncation.
 */

/**
 * Maximum whitespace-separated terms passed to `websearch_to_tsquery`.
 *
 * The request schema already caps `query` at 3000 characters, which bounds the
 * worst case but not tightly enough: 3000 characters of short distinct tokens is
 * still ~750 lexemes ORed into one expression. Real queries are far below this —
 * it is a ceiling on pathological input, not a limit users should ever meet.
 */
export const MAX_TSQUERY_TERMS = 96;

/**
 * Maximum characters in a single term. A very long unbroken token cannot match
 * anything useful (no indexed lexeme is this long) but still costs parsing work.
 */
export const MAX_TSQUERY_TERM_CHARS = 64;

/**
 * Bound a user query before it reaches `websearch_to_tsquery`.
 *
 * Collapses runs of whitespace, drops terms longer than
 * {@link MAX_TSQUERY_TERM_CHARS}, and keeps at most {@link MAX_TSQUERY_TERMS}
 * terms. Returns the input unchanged when it is already within bounds.
 */
export function boundTsqueryText(text: string): string {
  // Fast path: a string no longer than the per-term cap cannot violate EITHER
  // bound — it holds at most one term of that length, and far fewer than
  // MAX_TSQUERY_TERMS of them. Avoids splitting on every search, since this runs
  // on the hot path.
  if (text.length <= MAX_TSQUERY_TERM_CHARS) return text;

  const terms = text.trim().split(/\s+/);
  if (
    terms.length <= MAX_TSQUERY_TERMS &&
    !terms.some((t) => t.length > MAX_TSQUERY_TERM_CHARS)
  ) {
    return text;
  }
  return terms
    .filter((t) => t.length <= MAX_TSQUERY_TERM_CHARS)
    .slice(0, MAX_TSQUERY_TERMS)
    .join(' ');
}

/**
 * Bound the token list the graph entity-name seed ORs together.
 *
 * `candidates.ts` joins these with ` or ` into one `websearch_to_tsquery` call,
 * so the expression grows linearly with the token count — the same overflow
 * risk as the keyword signal, from a different direction. Tokens arrive from
 * `tokenize`, so they are already lowercased, de-duplicated and stopword-free;
 * this only caps how many are used.
 */
export function boundTsqueryTokens(tokens: string[]): string[] {
  if (tokens.length <= MAX_TSQUERY_TERMS) return tokens;
  return tokens.slice(0, MAX_TSQUERY_TERMS);
}
