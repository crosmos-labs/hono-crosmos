/**
 * Tokenizer + stopword list — verbatim port of `keyword.py:tokenize` /
 * `STOPWORDS`. Used by the keyword fallback AND graph entity-name seeding
 * (`graph.py:_seed_by_entity_name`), so it must stay identical to Python.
 */

// Verbatim from keyword.py. (Python builds a frozenset, so the duplicate
// "all" is harmless — a Set dedups it the same way.)
export const STOPWORDS: ReadonlySet<string> = new Set(
  (
    'a an the is are was were be been being have has had do does did ' +
    'will would shall should may might must can could of in on at to for ' +
    'with by from and or but not no nor so yet both either neither each ' +
    'every all any few more most other some such than too very just also ' +
    'about above after again against all am as because before below between ' +
    'during here how i if into it its me my myself now only out over own ' +
    'same she he they them their there these this those through under until ' +
    'up we what when where which while who whom why you your'
  ).split(/\s+/),
);

/**
 * Lowercase, strip non-word/space chars to spaces, split on whitespace, drop
 * stopwords and single-char tokens. Returns a Set (order-independent, like
 * Python's set comprehension).
 *
 * JS `\w` without the `u` flag matches `[A-Za-z0-9_]`, identical to Python's
 * default ASCII `\w`.
 */
export function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/);
  const out = new Set<string>();
  for (const t of tokens) {
    if (t.length > 1 && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

/** Set intersection size — `len(a & b)` in Python. */
export function intersectionSize(a: Set<string>, b: Set<string>): number {
  let n = 0;
  // Iterate the smaller set for speed.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) n++;
  return n;
}
