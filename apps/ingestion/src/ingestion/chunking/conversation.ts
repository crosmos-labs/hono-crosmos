/**
 * Conversation chunker — fixed-size turn windows with lookback.
 *
 * Ports `app/engine/chunking/conversation.py`. A conversation source is split
 * into windows of `SESSION_SEGMENT_SIZE` turns; each window carries the prior
 * window verbatim as `lookbackContext` for pronoun resolution during extraction
 * (the lookback is context only — it is never itself extracted from).
 */
import { SESSION_SEGMENT_SIZE } from '../../constants';

export interface ConversationChunk {
  sequence: number;
  content: string;
  lookbackContext: string | null;
}

const ROLE_PREFIX_RE = /^\s*(user|assistant|system|tool)\s*:\s*(.*)$/i;

export function chunkConversation(
  content: string,
  segmentSize: number = SESSION_SEGMENT_SIZE,
): ConversationChunk[] {
  if (!content || !content.trim()) return [];
  if (segmentSize <= 0) throw new Error('segmentSize must be positive');

  const turns = parseConversationTurns(content);
  if (turns.length === 0) return [];

  const chunks: ConversationChunk[] = [];
  let segmentIndex = 0;
  let priorSegmentContent: string | null = null;

  for (let start = 0; start < turns.length; start += segmentSize) {
    const segmentTurns = turns.slice(start, start + segmentSize);
    const segmentContent = segmentTurns.join('\n');
    chunks.push({
      sequence: segmentIndex,
      content: segmentContent,
      lookbackContext: priorSegmentContent,
    });
    priorSegmentContent = segmentContent;
    segmentIndex += 1;
  }

  return chunks;
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
