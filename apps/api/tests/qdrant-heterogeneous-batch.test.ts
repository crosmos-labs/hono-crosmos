import { afterEach, describe, expect, test } from 'bun:test';
import { QdrantStore } from '@crosmos/vector';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Qdrant heterogeneous ANN batch', () => {
  test('sends independent limits and thresholds in one transport request', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return Response.json({
        result: [
          [{ id: 10, score: 0.9 }, { id: 11, score: 0.05 }],
          [{ id: 20, score: 0.8 }],
        ],
      });
    }) as typeof fetch;
    const store = new QdrantStore({
      url: 'https://qdrant.invalid',
      apiKey: 'test',
      memoriesCollection: 'memories',
      entitiesCollection: 'entities',
    });

    const result = await store.queryNearestMany('memories', [
      { vector: [1, 2], scope: { orgId: 1, spaceId: 7 }, opts: { topK: 50, minScore: 0.1 } },
      { vector: [1, 2], scope: { orgId: 1, spaceId: 7 }, opts: { topK: 5, minScore: 0.2 } },
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toEndWith('/collections/memories/points/search/batch');
    expect(requests[0]?.body).toEqual({
      searches: [
        {
          vector: [1, 2], limit: 50,
          filter: { must: [{ key: 'spaceId', match: { value: 7 } }] },
          with_payload: false, with_vector: false, score_threshold: 0.1,
        },
        {
          vector: [1, 2], limit: 5,
          filter: { must: [{ key: 'spaceId', match: { value: 7 } }] },
          with_payload: false, with_vector: false, score_threshold: 0.2,
        },
      ],
    });
    // Client-side threshold parity is retained even if the backend over-returns.
    expect(result).toEqual([[{ id: 10, score: 0.9 }], [{ id: 20, score: 0.8 }]]);
  });

  test('preserves result positions for searches that cannot execute', async () => {
    globalThis.fetch = (async () => Response.json({
      result: [[{ id: 3, score: 0.7 }]],
    })) as unknown as typeof fetch;
    const store = new QdrantStore({
      url: 'https://qdrant.invalid', apiKey: 'test',
      memoriesCollection: 'memories', entitiesCollection: 'entities',
    });
    const result = await store.queryNearestMany('memories', [
      { vector: [], scope: { orgId: 1, spaceId: 1 }, opts: { topK: 50 } },
      { vector: [1], scope: { orgId: 1, spaceId: 1 }, opts: { topK: 5 } },
    ]);
    expect(result).toEqual([[], [{ id: 3, score: 0.7 }]]);
  });
});
