import { describe, expect, test } from 'bun:test';
import type { Reranker } from '@crosmos/ai';
import { formatDoc, formatQuery, rerankCandidates } from '../src/features/search/reranker';
import { SourceSignal, type RankedCandidate } from '../src/features/search/types';

function candidate(overrides: Partial<RankedCandidate> = {}): RankedCandidate {
  return {
    memoryId: 17,
    uuid: '0198c73a-bc8a-7000-8000-000000000017',
    content: 'Omar Haddad replaced Alina Rao as lead.',
    memoryType: 'fact',
    ownerUserId: 1,
    orgId: 2,
    spaceId: 3,
    importanceScore: null,
    createdAt: new Date('2026-04-18T09:00:00Z'),
    recordedAt: new Date('2026-04-18T09:00:00Z'),
    accessFrequency: 0,
    lastAccessedAt: new Date('2026-04-18T09:00:00Z'),
    eventTime: null,
    rank: 1,
    score: 1,
    source: SourceSignal.SEMANTIC,
    sourceChunk: null,
    sourceId: null,
    sourceUuid: null,
    sessionId: null,
    ...overrides,
  };
}

describe('search reranker document formatting', () => {
  test('retains the legacy event-date format by default', () => {
    expect(formatDoc(candidate({ eventTime: new Date('2026-10-20T12:00:00Z') }))).toBe(
      '[Date: October 20, 2026 (2026-10-20)] Omar Haddad replaced Alina Rao as lead.',
    );
  });

  test('adds recorded date metadata only for Voyage 2.5 models', async () => {
    const calls: Array<{ query: string; documents: string[] }> = [];
    const makeReranker = (defaultModel: string): Reranker => ({
      defaultModel,
      async rerank(query, documents) {
        calls.push({ query, documents });
        return [{ index: 0, score: 0.9 }];
      },
    });

    const item = candidate();
    await rerankCandidates(makeReranker('rerank-2.5'), 'Who leads it now?', [item]);
    await rerankCandidates(makeReranker('rerank-2.5-lite'), 'Who leads it now?', [item]);
    await rerankCandidates(makeReranker('zerank-2'), 'Who leads it now?', [item]);

    expect(calls[0]?.documents[0]).toStartWith('[Recorded: April 18, 2026 (2026-04-18)]');
    expect(calls[1]?.documents[0]).toStartWith('[Recorded: April 18, 2026 (2026-04-18)]');
    expect(calls[2]?.documents[0]).toBe(item.content);
  });

  test('scopes Voyage freshness instructions to current-information queries', () => {
    const voyage = { defaultModel: 'rerank-2.5' } as Reranker;
    const legacy = { defaultModel: 'zerank-2' } as Reranker;

    expect(formatQuery(voyage, 'Who currently leads Cedar Phoenix?')).toContain(
      'prefer a document with a later [Recorded: ...] date',
    );
    expect(formatQuery(voyage, 'Who owns Borealis Ledger?')).toBe(
      'Who owns Borealis Ledger?',
    );
    expect(formatQuery(legacy, 'Who currently leads Cedar Phoenix?')).toBe(
      'Who currently leads Cedar Phoenix?',
    );
  });
});
