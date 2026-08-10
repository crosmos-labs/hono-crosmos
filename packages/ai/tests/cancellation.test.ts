/**
 * P1-C — adapters honour a caller deadline, and report it honestly.
 *
 * Two behaviours matter here and they are easy to get wrong together:
 *
 *  1. the caller's signal must actually reach `fetch`, or "cancellation" is
 *     just the caller giving up while the provider call runs on;
 *  2. an abandoned request must NOT be reported as a provider failure. These
 *     adapters map timeouts to a retryable 504, which is right for a hung
 *     provider and wrong for a request the client walked away from — it blames
 *     the provider and invites a retry of work nobody is waiting for.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { OpenAICompatEmbedder, EmbeddingRequestError } from '../src/embeddings/openai-compat';
import { ZeroEntropyReranker, RerankerRequestError } from '../src/reranker/zeroentropy';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replace fetch with one that records the signal and behaves as instructed. */
function stubFetch(behaviour: (signal: AbortSignal | undefined) => Promise<Response>) {
  const seen: (AbortSignal | undefined)[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal | undefined;
    seen.push(signal);
    return behaviour(signal);
  }) as typeof fetch;
  return seen;
}

/** A fetch that never resolves until its signal aborts — a hung provider. */
const hangUntilAborted = (signal: AbortSignal | undefined) =>
  new Promise<Response>((_resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    signal?.addEventListener('abort', () =>
      reject(new DOMException('aborted', 'AbortError')),
    );
  });

const embedder = () =>
  new OpenAICompatEmbedder({
    baseUrl: 'https://provider.invalid/v1',
    apiKey: 'k',
    model: 'text-embedding-3-small',
    dimensions: 1536,
    providerLabel: 'TestProvider',
  });

describe('OpenAICompatEmbedder cancellation', () => {
  test('the caller signal reaches fetch', async () => {
    const caller = new AbortController();
    const seen = stubFetch(async () =>
      Response.json({
        data: [{ index: 0, embedding: Array(1536).fill(0.1) }],
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
    );

    await embedder().embed('hello', { signal: caller.signal });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(seen[0]!.aborted).toBe(false);
  });

  test('a caller abort surfaces as AbortError, not a provider failure', async () => {
    const caller = new AbortController();
    stubFetch(hangUntilAborted);

    const pending = embedder().embed('hello', { signal: caller.signal });
    caller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    // Crucially NOT an EmbeddingRequestError — that would be logged, counted and
    // retried as though the provider had failed.
    await expect(pending).rejects.not.toBeInstanceOf(EmbeddingRequestError);
  });

  test('an already-expired deadline fails immediately without a real call', async () => {
    const caller = new AbortController();
    caller.abort();
    stubFetch(hangUntilAborted);

    await expect(
      embedder().embed('hello', { signal: caller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('a provider error is still a retryable EmbeddingRequestError', async () => {
    stubFetch(async () => new Response('upstream boom', { status: 503 }));

    const err = await embedder()
      .embed('hello', { signal: new AbortController().signal })
      .catch((e) => e);

    expect(err).toBeInstanceOf(EmbeddingRequestError);
    expect((err as EmbeddingRequestError).retryable).toBe(true);
  });

  test('omitting the signal keeps the previous behaviour', async () => {
    const seen = stubFetch(async () =>
      Response.json({
        data: [{ index: 0, embedding: Array(1536).fill(0.1) }],
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
    );

    const { vector } = await embedder().embed('hello');
    expect(vector).toHaveLength(1536);
    // The adapter's own safety timeout is still attached.
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });
});

describe('ZeroEntropyReranker cancellation', () => {
  const reranker = () => new ZeroEntropyReranker({ apiKey: 'k' });

  test('the call is bounded even with no caller signal', async () => {
    // Before this change the reranker fetch had NO timeout at all, so a wedged
    // provider could pin an isolate indefinitely.
    const seen = stubFetch(async () => Response.json({ results: [] }));
    await reranker().rerank('q', ['a']);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });

  test('a caller abort surfaces as AbortError, not a provider failure', async () => {
    const caller = new AbortController();
    stubFetch(hangUntilAborted);

    const pending = reranker().rerank('q', ['a'], { signal: caller.signal });
    caller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(pending).rejects.not.toBeInstanceOf(RerankerRequestError);
  });

  test('a provider error is still a RerankerRequestError', async () => {
    stubFetch(async () => new Response('nope', { status: 500 }));
    await expect(reranker().rerank('q', ['a'])).rejects.toBeInstanceOf(
      RerankerRequestError,
    );
  });

  test('an empty document set makes no network call at all', async () => {
    const seen = stubFetch(async () => Response.json({ results: [] }));
    expect(await reranker().rerank('q', [])).toEqual([]);
    expect(seen).toHaveLength(0);
  });
});
