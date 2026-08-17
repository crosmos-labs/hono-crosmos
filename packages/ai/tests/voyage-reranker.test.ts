import { afterEach, describe, expect, test } from 'bun:test';
import { RerankerRequestError } from '../src/reranker/zeroentropy';
import { VoyageReranker } from '../src/reranker/voyage';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('VoyageReranker', () => {
  test('maps Voyage scores to original document indexes and sorts descending', async () => {
    let request: Request | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      return Response.json({
        results: [
          { index: 0, relevance_score: 0.25 },
          { index: 1, relevance_score: 0.9 },
        ],
        total_tokens: 12,
      });
    }) as typeof fetch;

    const reranker = new VoyageReranker({ apiKey: 'voyage-key' });
    const result = await reranker.rerank('query', ['first', 'second'], { topK: 2 });

    expect(result).toEqual([
      { index: 1, score: 0.9 },
      { index: 0, score: 0.25 },
    ]);
    expect(request?.url).toBe('https://api.voyageai.com/v1/rerank');
    expect(request?.headers.get('authorization')).toBe('Bearer voyage-key');
    expect(await request?.json()).toEqual({
      model: 'rerank-2.5',
      query: 'query',
      documents: ['first', 'second'],
      return_documents: false,
      truncation: true,
      top_k: 2,
    });
  });

  test('supports the latency-oriented 2.5-lite model', async () => {
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ results: [] });
    }) as typeof fetch;

    await new VoyageReranker({ apiKey: 'k', model: 'rerank-2.5-lite' })
      .rerank('q', ['doc']);
    expect(body?.model).toBe('rerank-2.5-lite');
  });

  test('propagates caller cancellation without blaming Voyage', async () => {
    const caller = new AbortController();
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        signal.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      })) as typeof fetch;

    const pending = new VoyageReranker({ apiKey: 'k' })
      .rerank('q', ['doc'], { signal: caller.signal });
    caller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(pending).rejects.not.toBeInstanceOf(RerankerRequestError);
  });

  test('maps provider failures to the shared retryable error', async () => {
    globalThis.fetch = (async () => new Response('busy', { status: 503 })) as typeof fetch;

    const error = await new VoyageReranker({ apiKey: 'k' })
      .rerank('q', ['doc'])
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(RerankerRequestError);
    expect((error as RerankerRequestError).retryable).toBe(true);
  });

  test('does not call Voyage for an empty candidate set', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({ results: [] });
    }) as typeof fetch;

    expect(await new VoyageReranker({ apiKey: 'k' }).rerank('q', [])).toEqual([]);
    expect(calls).toBe(0);
  });
});
