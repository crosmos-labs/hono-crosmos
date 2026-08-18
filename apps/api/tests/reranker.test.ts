import { describe, expect, test } from 'bun:test';
import type { Reranker } from '@crosmos/ai';
import { formatDoc, rerankCandidates } from '../src/features/search/reranker';
import { rerankRelevanceFloor } from '../src/features/search/constants';
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
});

describe('per-model relevance floor', () => {
  test('only calibrated models get an absolute threshold', () => {
    // Voyage 2.5 scored the same off-topic pair 6x higher than zerank-2
    // (0.190 vs 0.030) in the 2026-08-19 production measurement, so the two
    // thresholds are deliberately far apart rather than shared.
    expect(rerankRelevanceFloor('rerank-2.5')).toBe(0.4);
    expect(rerankRelevanceFloor('zerank-2')).toBe(0.02);
  });

  test('an uncalibrated model is never absolute-filtered', () => {
    // Failing open matters: applying another model's threshold can only lose
    // recall. `rerank-2.5-lite` is the Voyage 429 fallback and has no
    // calibration of its own.
    expect(rerankRelevanceFloor('rerank-2.5-lite')).toBeNull();
    expect(rerankRelevanceFloor('@cf/baai/bge-reranker-base')).toBeNull();
    expect(rerankRelevanceFloor('')).toBeNull();
  });

  test('the floor sits below the weakest measured gold and above the strongest noise', () => {
    // Guards the calibration itself: production 2026-08-19 over 44 positive
    // and 47 off-topic queries. Weakest gold 0.4863 ("what should I know
    // before booking my flight?"); strongest off-topic hit 0.4883 is an
    // entity-overlapping adversarial probe, with ordinary noise topping out
    // at 0.4199. The floor must clear ordinary noise and keep real headroom.
    const floor = rerankRelevanceFloor('rerank-2.5')!;
    expect(floor).toBeLessThan(0.4863);
    expect(0.4863 - floor).toBeGreaterThanOrEqual(0.08);
    expect(floor).toBeGreaterThan(0.3242); // max non-adversarial negative
  });
});

describe('rerank scoring-model reporting', () => {
  test('reports the model that actually produced the scores, not the default', async () => {
    // Voyage degrades to rerank-2.5-lite on a 429. The floor is keyed off this
    // value, so reporting the configured default would apply 2.5's calibrated
    // threshold to scores a different model produced.
    const degrading: Reranker = {
      defaultModel: 'rerank-2.5',
      async rerank(_query, _documents, opts) {
        opts?.onModelResolved?.('rerank-2.5-lite');
        return [{ index: 0, score: 0.31 }];
      },
    };

    const result = await rerankCandidates(degrading, 'q', [candidate()]);
    expect(result.model).toBe('rerank-2.5-lite');
    expect(rerankRelevanceFloor(result.model)).toBeNull();
    expect(result.scores.get(17)).toBe(0.31);
  });

  test('falls back to the default model when an adapter reports nothing', async () => {
    const silent: Reranker = {
      defaultModel: 'rerank-2.5',
      rerank: async () => [{ index: 0, score: 0.9 }],
    };
    const result = await rerankCandidates(silent, 'q', [candidate()]);
    expect(result.model).toBe('rerank-2.5');
  });

  test('an empty candidate list makes no call and still names a model', async () => {
    let called = false;
    const never: Reranker = {
      defaultModel: 'rerank-2.5',
      async rerank() { called = true; return []; },
    };
    const result = await rerankCandidates(never, 'q', []);
    expect(called).toBe(false);
    expect(result.model).toBe('rerank-2.5');
    expect(result.scores.size).toBe(0);
  });
});
