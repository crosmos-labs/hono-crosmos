/**
 * Conversation formatting for ingestion. The whole conversation is stored as a
 * single `conversation` source; the ingestion pipeline segments it into
 * fixed-size turn windows (with per-window lookback context) at chunk time —
 * see `apps/ingestion/src/ingestion/chunking/conversation.ts`. Segmentation
 * used to live here as `segmentMessages`/`buildContext`, but those were never
 * wired up and are superseded by pipeline-level chunking.
 */
export interface SessionMessage {
  role: string;
  content: string;
}

export function formatMessages(messages: readonly SessionMessage[]): string {
  return messages.map((m) => `${m.role}: ${m.content}`).join('\n');
}
