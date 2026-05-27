/**
 * Query intent classifier — verbatim port of `app/engine/retrieval/intent.py`.
 *
 * ⚠️ `analyzeQueryIntent` is NOT wired into `service.retrieve` (Python's
 * `service.py` never imports it). Ported for completeness/parity; it does not
 * affect ranking. See .codex/pipelines.md.
 *
 * Patterns are the contract: input is lowercased + whitespace-collapsed, then
 * matched case-sensitively (Python compiles them WITHOUT re.IGNORECASE).
 * First match wins, in order PREFERENCE → PERSONAL → ENTITY_LOOKUP → FACTUAL.
 */
import { IntentAnalysis, QueryIntent } from './types';

const PREFERENCE_PATTERNS = [
  /\b(prefer|preference|preferences|favorite|favourite)\b/,
  /\b(what do i like|what do i love|what do i hate|what do i dislike)\b/,
  /\b(my (?:favorite|favourite|preferred|liked|disliked|hated|loved|preferences))\b/,
  /\b(what kind of .+ (?:do i|i like|i prefer))\b/,
];

const PERSONAL_PATTERNS = [
  /\b(my|me|mine|i|myself)\b/,
  /\b(do you remember|you know|you recall)\b/,
  /\b(what am i|who am i|where do i|where did i|what do i|what did i|what have i)\b/,
  /\b(tell me about myself|about me)\b/,
];

const ENTITY_LOOKUP_PATTERNS = [
  /\b(who is|who was|who are|who were)\b/,
  /\b(whose .+ (?:is|are|was|were))\b/,
  /\b(where does .+ work|where do .+ work|where did .+ work)\b/,
  /\b(where is .+ (?:from|located|based))\b/,
  /\b(what does .+ do|what do .+ do)\b/,
  /\b(tell me about .+)\b.{0,10}$/,
];

function firstMatch(
  lowered: string,
  patterns: RegExp[],
  intent: QueryIntent,
  confidence: number,
): IntentAnalysis | null {
  for (const pattern of patterns) {
    const m = pattern.exec(lowered);
    if (m) return { intent, confidence, matchedText: m[0] };
  }
  return null;
}

export function analyzeQueryIntent(query: string): IntentAnalysis {
  const defaults: IntentAnalysis = {
    intent: QueryIntent.FACTUAL,
    confidence: 0.0,
    matchedText: null,
  };
  if (!query || !query.trim()) return defaults;

  const lowered = query.trim().split(/\s+/).join(' ').toLowerCase();

  return (
    firstMatch(lowered, PREFERENCE_PATTERNS, QueryIntent.PREFERENCE, 0.9) ??
    firstMatch(lowered, PERSONAL_PATTERNS, QueryIntent.PERSONAL, 0.85) ??
    firstMatch(lowered, ENTITY_LOOKUP_PATTERNS, QueryIntent.ENTITY_LOOKUP, 0.8) ??
    defaults
  );
}
