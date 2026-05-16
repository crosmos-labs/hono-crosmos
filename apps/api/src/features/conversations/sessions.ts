import { LOOKBACK_WINDOW, SEGMENT_SIZE } from '../sources/constants';

/**
 * Multi-turn conversation segmentation. Mirrors
 * `app/engine/ingestion/sessions.py` exactly — segment size 4, lookback
 * window 4. The pipeline consumes `meta.lookback_context` set per segment
 * for pronoun resolution only (it is never extracted from).
 */
export interface SessionMessage {
  role: string;
  content: string;
}

export function formatMessages(messages: readonly SessionMessage[]): string {
  return messages.map((m) => `${m.role}: ${m.content}`).join('\n');
}

export function segmentMessages(
  messages: readonly SessionMessage[],
  segmentSize: number = SEGMENT_SIZE,
): SessionMessage[][] {
  const segments: SessionMessage[][] = [];
  for (let i = 0; i < messages.length; i += segmentSize) {
    segments.push(messages.slice(i, i + segmentSize));
  }
  return segments;
}

/**
 * Concatenates the prior `window` segments (each as `role: content` lines)
 * into one context blob. Returns `null` for the first segment so callers
 * can omit `lookback_context` from `meta` rather than write an empty string.
 */
export function buildContext(
  segments: readonly SessionMessage[][],
  currentIndex: number,
  window: number = LOOKBACK_WINDOW,
): string | null {
  const start = Math.max(0, currentIndex - window);
  const prior = segments.slice(start, currentIndex);
  if (prior.length === 0) return null;
  return prior.map(formatMessages).join('\n\n');
}
