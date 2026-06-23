/**
 * Chunk dispatcher — routes a source to the right chunker by content type.
 * Ports `app/engine/ingestion/pipeline.py:_chunk_source`.
 *
 * Conversations (or any source carrying a `session_id`) are segmented into
 * turn windows. Text and markdown are split by a recursive character splitter
 * (issue #7) so a large document isn't one unbounded chunk — the full `chonkie`
 * port (heading-aware) is a separate, larger effort.
 */
import { chunkConversation } from './conversation';
import { chunkText } from './text';

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

  // text / markdown — recursive character splitter (issue #7). No lookback
  // context: unlike conversations, prose windows aren't turn-coreferent.
  return chunkText(content).map((chunkContent, i) => ({
    sequence: i,
    content: chunkContent,
    context: null,
    chunker: 'recursive',
  }));
}

export { chunkConversation, parseConversationTurns } from './conversation';
export { chunkText } from './text';
export type { ConversationChunk } from './conversation';
