import { describe, expect, test } from 'bun:test';
import { DoRateLimiter } from '../src/integrations/rate-limit/do';
import { RateLimitError } from '../src/integrations/rate-limit/port';

interface StubCall {
  key: string;
  body: unknown;
}

/**
 * Minimal DurableObjectNamespace double. `delayMs` simulates a cold instance:
 * the DO's own work is instant, the time is spent before the request lands,
 * which is exactly the production signature (an 11.8s subrequest wrapping a
 * 0ms inner execution).
 */
function namespace(opts: {
  delayMs?: number;
  results?: Array<{ scope: string; success: boolean; count: number }>;
  throws?: boolean;
  calls?: StubCall[];
}) {
  return {
    idFromName: (key: string) => ({ key }),
    get: (id: { key: string }) => ({
      fetch: async (_url: string, init: { body: string }) => {
        opts.calls?.push({ key: id.key, body: JSON.parse(init.body) });
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        if (opts.throws) throw new Error('do unavailable');
        return {
          json: async () => ({ success: true, results: opts.results ?? [] }),
        };
      },
    }),
  } as unknown as DurableObjectNamespace;
}

describe('DoRateLimiter latency budget', () => {
  test('enforces normally when the limiter answers inside the budget', async () => {
    const limiter = new DoRateLimiter(
      namespace({ results: [{ scope: 'rpm', success: false, count: 11 }] }),
      undefined,
      250,
    );
    await expect(
      limiter.check({ orgId: 7, rpmLimit: 10, dailyLimit: -1 }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  test('admits when the limiter is over budget, and defers the increment', async () => {
    const deferred: Array<Promise<unknown>> = [];
    const calls: StubCall[] = [];
    const limiter = new DoRateLimiter(
      namespace({
        delayMs: 60,
        calls,
        // Would have been a 429 had we waited for it.
        results: [{ scope: 'rpm', success: false, count: 99 }],
      }),
      (task) => deferred.push(task),
      10,
    );

    // Admitted rather than throwing, despite the limiter saying "over limit".
    await limiter.check({ orgId: 7, rpmLimit: 10, dailyLimit: -1 });

    // The call was handed off, not cancelled, so the counter still increments.
    expect(deferred).toHaveLength(1);
    await deferred[0];
    expect(calls).toHaveLength(1);
    expect(calls[0]!.key).toBe('rl:7');
  });

  test('fails open when the limiter errors', async () => {
    const limiter = new DoRateLimiter(namespace({ throws: true }), undefined, 250);
    await limiter.check({ orgId: 7, rpmLimit: 10, dailyLimit: -1 });
  });

  test('skips the round-trip entirely when both windows are uncapped', async () => {
    const calls: StubCall[] = [];
    const limiter = new DoRateLimiter(namespace({ calls }), undefined, 250);
    await limiter.check({ orgId: 7, rpmLimit: -1, dailyLimit: -1 });
    expect(calls).toHaveLength(0);
  });
});

describe('DoRateLimiter without a defer', () => {
  test('waits for the full call rather than dropping the increment', async () => {
    const calls: StubCall[] = [];
    const limiter = new DoRateLimiter(
      namespace({
        delayMs: 40,
        calls,
        results: [{ scope: 'rpm', success: false, count: 99 }],
      }),
      undefined, // no defer: nowhere to finish an abandoned call
      10, // budget far below the delay
    );

    // Still enforces, because the budget must not apply when the increment
    // cannot be completed in the background.
    await expect(
      limiter.check({ orgId: 7, rpmLimit: 10, dailyLimit: -1 }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(calls).toHaveLength(1);
  });
});
