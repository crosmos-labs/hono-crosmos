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
        object: 'list',
        data: [
          { index: 0, relevance_score: 0.25 },
          { index: 1, relevance_score: 0.9 },
        ],
        model: 'rerank-2.5',
        usage: { total_tokens: 12 },
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
      return Response.json({ data: [] });
    }) as typeof fetch;

    await new VoyageReranker({ apiKey: 'k', model: 'rerank-2.5-lite' })
      .rerank('q', ['doc']);
    expect(body?.model).toBe('rerank-2.5-lite');
  });

  test('falls back from 2.5 to 2.5-lite exactly once on HTTP 429', async () => {
    const models: string[] = [];
    const fallbacks: Array<{
      primaryModel: string;
      fallbackModel: string;
      retryAfterSeconds?: number;
    }> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      models.push(body.model);
      if (models.length === 1) {
        return new Response('rate limited', {
          status: 429,
          headers: { 'Retry-After': '2' },
        });
      }
      return Response.json({ data: [{ index: 0, relevance_score: 0.8 }] });
    }) as typeof fetch;

    const result = await new VoyageReranker({
      apiKey: 'k',
      rateLimitFallbackModel: 'rerank-2.5-lite',
      onRateLimitFallback: (event) => fallbacks.push(event),
    }).rerank('q', ['doc']);

    expect(models).toEqual(['rerank-2.5', 'rerank-2.5-lite']);
    expect(fallbacks).toEqual([{
      primaryModel: 'rerank-2.5',
      fallbackModel: 'rerank-2.5-lite',
      retryAfterSeconds: 2,
    }]);
    expect(result).toEqual([{ index: 0, score: 0.8 }]);
  });

  test('does not fall back on non-rate-limit provider errors', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('unavailable', { status: 503 });
    }) as typeof fetch;

    const error = await new VoyageReranker({
      apiKey: 'k',
      rateLimitFallbackModel: 'rerank-2.5-lite',
    }).rerank('q', ['doc']).catch((caught) => caught);

    expect(calls).toBe(1);
    expect(error).toBeInstanceOf(RerankerRequestError);
    expect((error as RerankerRequestError).status).toBe(503);
  });

  test('a 429 from the lite fallback is surfaced without a retry loop', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('rate limited', { status: 429 });
    }) as typeof fetch;

    const error = await new VoyageReranker({
      apiKey: 'k',
      rateLimitFallbackModel: 'rerank-2.5-lite',
    }).rerank('q', ['doc']).catch((caught) => caught);

    expect(calls).toBe(2);
    expect(error).toBeInstanceOf(RerankerRequestError);
    expect((error as RerankerRequestError).status).toBe(429);
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

  test('maps a malformed success envelope to a shared provider error', async () => {
    globalThis.fetch = (async () => Response.json({ results: [] })) as typeof fetch;

    const error = await new VoyageReranker({ apiKey: 'k' })
      .rerank('q', ['doc'])
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(RerankerRequestError);
    expect((error as RerankerRequestError).status).toBe(502);
  });

  test('does not call Voyage for an empty candidate set', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({ data: [] });
    }) as typeof fetch;

    expect(await new VoyageReranker({ apiKey: 'k' }).rerank('q', [])).toEqual([]);
    expect(calls).toBe(0);
  });
});
