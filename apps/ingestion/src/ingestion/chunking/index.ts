/**
 * Chunk dispatcher — routes a source to the right chunker by content type.
 * Ports `app/engine/ingestion/pipeline.py:_chunk_source`.
 *
 * Conversations (or any source carrying a `session_id`) are segmented into
 * turn windows. Text and markdown currently pass through as a single chunk:
 * Python sub-chunks them with `chonkie` (recursive / heading-aware), which is a
 * separate, larger port — this preserves today's one-chunk-per-source behavior
 * for those types while making the conversation path finer-grained.
 */
import { chunkConversation } from './conversation';

export interface SourceChunk {
  sequence: number;
  content: string;
  /** Lookback context for pronoun resolution (conversation only); else null. */
  context: string | null;
  /** Label persisted on the chunk row: 'conversation' | 'legacy'. */
  chunker: string;
}

export function chunkSource(
  contentType: string,
  content: string,
  meta: Record<string, unknown>,
): SourceChunk[] {
  if (contentType === 'conversation' || typeof meta.session_id === 'string') {
    return chunkConversation(content).map((c) => ({
      sequence: c.sequence,
      content: c.content,
      context: c.lookbackContext,
      chunker: 'conversation',
    }));
  }

  // text / markdown — single chunk (no chonkie port yet).
  return [{ sequence: 0, content, context: null, chunker: 'legacy' }];
}

export { chunkConversation, parseConversationTurns } from './conversation';
export type { ConversationChunk } from './conversation';
