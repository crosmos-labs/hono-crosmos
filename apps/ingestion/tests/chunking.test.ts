import { describe, expect, test } from 'bun:test';
import {
  chunkConversation,
  parseConversationTurns,
} from '../src/ingestion/chunking/conversation';
import { chunkSource } from '../src/ingestion/chunking';
import { SESSION_SEGMENT_SIZE } from '../src/constants';

const convo = (turns: number): string =>
  Array.from({ length: turns }, (_, i) =>
    i % 2 === 0 ? `user: message ${i}` : `assistant: reply ${i}`,
  ).join('\n');

describe('parseConversationTurns', () => {
  test('splits on role-prefixed lines, one turn per message', () => {
    const turns = parseConversationTurns('user: hi\nassistant: hello\nuser: bye');
    expect(turns).toEqual(['user: hi', 'assistant: hello', 'user: bye']);
  });

  test('keeps multiline messages in a single turn', () => {
    const turns = parseConversationTurns(
      'user: line one\ncontinuation line\nassistant: ok',
    );
    expect(turns).toEqual(['user: line one\ncontinuation line', 'assistant: ok']);
  });

  test('lowercases the role and is case-insensitive on the prefix', () => {
    const turns = parseConversationTurns('USER: Hi\nAssistant: Yo');
    expect(turns).toEqual(['user: Hi', 'assistant: Yo']);
  });

  test('content with no role prefixes collapses to a single turn', () => {
    const turns = parseConversationTurns('just some\nplain text');
    expect(turns).toEqual(['just some\nplain text']);
  });

  test('recognizes system and tool roles', () => {
    const turns = parseConversationTurns('system: setup\ntool: result');
    expect(turns).toEqual(['system: setup', 'tool: result']);
  });
});

describe('chunkConversation', () => {
  test('returns no chunks for empty/whitespace content', () => {
    expect(chunkConversation('')).toEqual([]);
    expect(chunkConversation('   \n  ')).toEqual([]);
  });

  test('windows turns by the default segment size', () => {
    const chunks = chunkConversation(convo(SESSION_SEGMENT_SIZE * 2 + 1));
    expect(chunks.length).toBe(3); // 4 + 4 + 1
    expect(chunks[0]!.sequence).toBe(0);
    expect(chunks[1]!.sequence).toBe(1);
    expect(chunks[2]!.content.split('\n').length).toBe(1); // trailing partial
  });

  test('first chunk has no lookback; later chunks carry the prior window verbatim', () => {
    const chunks = chunkConversation(convo(8));
    expect(chunks[0]!.lookbackContext).toBeNull();
    expect(chunks[1]!.lookbackContext).toBe(chunks[0]!.content);
  });

  test('honors a custom segment size', () => {
    const chunks = chunkConversation(convo(6), 2);
    expect(chunks.length).toBe(3);
    expect(chunks.every((c) => c.content.split('\n').length === 2)).toBe(true);
  });

  test('rejects a non-positive segment size', () => {
    expect(() => chunkConversation(convo(4), 0)).toThrow();
  });
});

describe('chunkSource dispatch', () => {
  test('routes conversation content_type to the conversation chunker', () => {
    const chunks = chunkSource('conversation', convo(8), {});
    expect(chunks.length).toBe(2);
    expect(chunks.every((c) => c.chunker === 'conversation')).toBe(true);
    expect(chunks[1]!.context).toBe(chunks[0]!.content);
  });

  test('routes any source with a session_id to the conversation chunker', () => {
    const chunks = chunkSource('text', convo(4), { session_id: 'abc' });
    expect(chunks[0]!.chunker).toBe('conversation');
  });

  test('chunks short text/markdown into a single recursive chunk', () => {
    const text = chunkSource('text', 'hello world', {});
    expect(text).toEqual([
      { sequence: 0, content: 'hello world', context: null, chunker: 'recursive' },
    ]);
    const md = chunkSource('markdown', '# Title\n\nbody', {});
    expect(md.length).toBe(1);
    expect(md[0]!.chunker).toBe('recursive');
    expect(md[0]!.context).toBeNull();
  });

  test('splits long text into multiple bounded recursive chunks', () => {
    // ~30 paragraphs of ~300 chars each ≈ 9k chars → several ~2k-char chunks.
    const para = `${'word '.repeat(60)}`.trim();
    const long = Array.from({ length: 30 }, () => para).join('\n\n');
    const chunks = chunkSource('text', long, {});
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.chunker === 'recursive')).toBe(true);
    // Sequences are contiguous from 0; no chunk exceeds the hard cap.
    chunks.forEach((c, i) => expect(c.sequence).toBe(i));
    expect(chunks.every((c) => c.content.length <= 4_000)).toBe(true);
  });
});
