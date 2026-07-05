/**
 * Conversation chunker — fixed-size turn windows with lookback.
 *
 * Ports `app/engine/chunking/conversation.py`. A conversation source is split
 * into windows of `SESSION_SEGMENT_SIZE` turns; each window carries the prior
 * window as `lookbackContext` for pronoun resolution during extraction (the
 * lookback is context only — it is never itself extracted from). A window whose
 * turns exceed `CONVERSATION_MAX_CHARS` is split so no chunk overruns the
 * embedder's input limit or truncates extraction; splits fall on turn boundaries.
 */
import { CONVERSATION_MAX_CHARS, SESSION_SEGMENT_SIZE } from '../../constants';
import { splitToAtoms } from './text';

export interface ConversationChunk {
  sequence: number;
  content: string;
  lookbackContext: string | null;
}

const ROLE_PREFIX_RE = /^\s*(user|assistant|system|tool)\s*:\s*(.*)$/i;

export function chunkConversation(
  content: string,
  segmentSize: number = SESSION_SEGMENT_SIZE,
  maxChars: number = CONVERSATION_MAX_CHARS,
): ConversationChunk[] {
  if (!content || !content.trim()) return [];
  if (segmentSize <= 0) throw new Error('segmentSize must be positive');
  if (maxChars <= 0) throw new Error('maxChars must be positive');

  const turns = parseConversationTurns(content);
  if (turns.length === 0) return [];

  const chunks: ConversationChunk[] = [];
  let sequence = 0;
  let priorLookback: string | null = null;

  for (let start = 0; start < turns.length; start += segmentSize) {
    const segmentTurns = turns.slice(start, start + segmentSize);
    const segmentContent = segmentTurns.join('\n');

    const pieces =
      segmentContent.length <= maxChars
        ? [segmentContent]
        : splitOversizedSegment(segmentTurns, maxChars);

    for (const piece of pieces) {
      chunks.push({ sequence, content: piece, lookbackContext: priorLookback });
      sequence += 1;
    }

    // Bound the lookback too: a huge prior window would bloat the next chunk's
    // extraction prompt. Keep the tail — the most recent, most relevant context.
    priorLookback =
      segmentContent.length <= maxChars
        ? segmentContent
        : segmentContent.slice(-maxChars);
  }

  return chunks;
}

/**
 * Pack whole turns into pieces of at most `maxChars` characters, hard splitting
 * any single turn that alone exceeds the limit via the shared text splitter.
 */
function splitOversizedSegment(turns: string[], maxChars: number): string[] {
  const pieces: string[] = [];
  let current: string[] = [];
  let currentLen = 0;

  const flush = () => {
    if (current.length > 0) {
      pieces.push(current.join('\n'));
      current = [];
      currentLen = 0;
    }
  };

  for (const turn of turns) {
    if (turn.length > maxChars) {
      flush();
      pieces.push(...splitToAtoms(turn, maxChars));
      continue;
    }
    // +1 accounts for the newline joining this turn to the current piece.
    let addition = turn.length + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && currentLen + addition > maxChars) {
      flush();
      addition = turn.length;
    }
    current.push(turn);
    currentLen += addition;
  }

  flush();
  return pieces;
}

/**
 * Parse role-prefixed conversation text into turns.
 *
 * API conversation ingestion stores messages as `role: message`, one message
 * per line (see `formatMessages`). Only role-prefixed lines start a new turn;
 * every other line belongs to the current turn so multiline messages stay
 * intact. Content with no role prefixes at all collapses to a single turn,
 * matching the Python parser.
 */
export function parseConversationTurns(content: string): string[] {
  const turns: string[] = [];
  let currentTurn: string[] = [];

  for (const line of content.trim().split(/\r?\n/)) {
    const roleMatch = ROLE_PREFIX_RE.exec(line);
    if (roleMatch) {
      if (currentTurn.length > 0) {
        turns.push(currentTurn.join('\n').trim());
      }
      const role = roleMatch[1]!.toLowerCase();
      const message = roleMatch[2]!.replace(/\s+$/, '');
      currentTurn = [`${role}: ${message}`.replace(/\s+$/, '')];
      continue;
    }

    if (currentTurn.length > 0) {
      currentTurn.push(line);
    } else if (line.trim()) {
      currentTurn = [line];
    }
  }

  if (currentTurn.length > 0) {
    turns.push(currentTurn.join('\n').trim());
  }

  return turns;
}
