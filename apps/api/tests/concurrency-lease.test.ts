/**
 * P1-G — stable recall identity through the concurrency limiter.
 *
 * The Durable Object has understood an optional `leaseKey` since the incident
 * remediation, but nothing could supply one: the search schema, the limiter
 * interface and the adapter all dropped it, so retried copies of a single
 * logical recall each consumed a slot and competed for the very capacity they
 * were waiting on. During the 2026-07-25 incident that class was 52.98% of all
 * search invocations.
 *
 * These tests pin the plumbing: the DO adapter forwards the key, the KV and
 * no-op limiters stay compatible, and omitting the field preserves the old
 * behavior exactly.
 */
import { describe, expect, test } from 'bun:test';
import {
  DoConcurrencyLimiter,
  KvConcurrencyLimiter,
  NoopConcurrencyLimiter,
} from '../src/features/search/concurrency';
import { SearchRequestSchema } from '../src/features/search/schemas';

/**
 * Minimal stand-in for the RateLimiterDO's concurrency endpoints, implementing
 * the same lease semantics the real class does, so the adapter is exercised
 * against real behavior rather than a recorded call list.
 */
function fakeNamespace(limit = 2) {
  const instances = new Map<string, Map<string, number>>();
  const requests: { instance: string; body: Record<string, unknown> }[] = [];

  const ns = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      fetch: async (url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        requests.push({ instance: name, body });
        const slots = instances.get(name) ?? new Map<string, number>();
        instances.set(name, slots);

        if (url.endsWith('/acquire')) {
          const leaseKey = body.leaseKey as string | undefined;
          if (leaseKey !== undefined && slots.has(leaseKey)) {
            return Response.json({ success: true, token: leaseKey, reused: true });
          }
          if (slots.size >= limit) return Response.json({ success: false });
          const token = leaseKey ?? crypto.randomUUID();
          slots.set(token, Date.now() + 60_000);
          return Response.json({ success: true, token });
        }
        const token = body.token as string | undefined;
        return Response.json({
          success: token !== undefined && slots.delete(token),
        });
      },
    }),
  };

  return {
    limiter: new DoConcurrencyLimiter(ns as unknown as DurableObjectNamespace),
    requests,
    liveSlots: (userKey: string) => instances.get(`conc:${userKey}`)?.size ?? 0,
  };
}

describe('recall_id in the search request schema', () => {
  test('is optional — omitting it parses and leaves the field undefined', () => {
    const parsed = SearchRequestSchema.parse({
      query: 'hello',
      space_id: '018f4c1e-6a7b-7c8d-9e0f-1a2b3c4d5e6f',
    });
    expect(parsed.recall_id).toBeUndefined();
  });

  test('accepts a uuid and rejects a non-uuid', () => {
    const id = '018f4c1e-6a7b-7c8d-9e0f-1a2b3c4d5e6f';
    expect(
      SearchRequestSchema.parse({
        query: 'hello',
        space_id: id,
        recall_id: id,
      }).recall_id,
    ).toBe(id);

    expect(() =>
      SearchRequestSchema.parse({
        query: 'hello',
        space_id: id,
        recall_id: 'not-a-uuid',
      }),
    ).toThrow();
  });

  test('adding the field did not change any existing default', () => {
    const parsed = SearchRequestSchema.parse({
      query: 'hello',
      space_id: '018f4c1e-6a7b-7c8d-9e0f-1a2b3c4d5e6f',
    });
    expect(parsed.limit).toBe(10);
    expect(parsed.recency_bias).toBeNull();
    expect(parsed.rerank).toBe(true);
    expect(parsed.graph).toBe(true);
    expect(parsed.diversify).toBe(false);
    expect(parsed.include_source).toBe(true);
  });
});

describe('DoConcurrencyLimiter — logical lease reuse', () => {
  test('repeated acquisition of the same live recall id reuses one slot', async () => {
    const { limiter, liveSlots } = fakeNamespace(2);

    const first = await limiter.acquire('7', 2, 60, 'recall-a');
    const second = await limiter.acquire('7', 2, 60, 'recall-a');
    const third = await limiter.acquire('7', 2, 60, 'recall-a');

    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(true);
    expect(third.acquired).toBe(true);
    expect(second.token).toBe(first.token);
    expect(liveSlots('7')).toBe(1);
  });

  test('different recall ids consume independent slots', async () => {
    const { limiter, liveSlots } = fakeNamespace(2);

    expect((await limiter.acquire('7', 2, 60, 'recall-a')).acquired).toBe(true);
    expect((await limiter.acquire('7', 2, 60, 'recall-b')).acquired).toBe(true);
    expect(liveSlots('7')).toBe(2);
    // Third distinct recall is over the cap and must be shed.
    expect((await limiter.acquire('7', 2, 60, 'recall-c')).acquired).toBe(false);
  });

  test('leases are namespaced per user, so ids cannot collide across users', async () => {
    const { limiter, liveSlots } = fakeNamespace(2);

    await limiter.acquire('7', 2, 60, 'recall-a');
    await limiter.acquire('8', 2, 60, 'recall-a');

    expect(liveSlots('7')).toBe(1);
    expect(liveSlots('8')).toBe(1);
  });

  test('omitting the key preserves the previous per-request slot behavior', async () => {
    const { limiter, liveSlots, requests } = fakeNamespace(2);

    const a = await limiter.acquire('7', 2, 60);
    const b = await limiter.acquire('7', 2, 60);

    expect(a.token).not.toBe(b.token);
    expect(liveSlots('7')).toBe(2);
    expect((await limiter.acquire('7', 2, 60)).acquired).toBe(false);
    // The field is absent from the wire payload, so an older DO deployment that
    // does not know about `leaseKey` sees exactly the request it saw before.
    expect(requests.every((r) => r.body.leaseKey === undefined)).toBe(true);
  });

  test('releasing by token frees the reused slot exactly once', async () => {
    const { limiter, liveSlots } = fakeNamespace(2);

    const lease = await limiter.acquire('7', 2, 60, 'recall-a');
    await limiter.acquire('7', 2, 60, 'recall-a');
    await limiter.release('7', lease.token);

    expect(liveSlots('7')).toBe(0);
    // A second release of the same token is a no-op, not a decrement of some
    // other request's lease.
    await limiter.release('7', lease.token);
    expect(liveSlots('7')).toBe(0);
  });

  test('a null token releases nothing (fail-open acquire must not free a slot)', async () => {
    const { limiter, liveSlots } = fakeNamespace(2);

    await limiter.acquire('7', 2, 60, 'recall-a');
    await limiter.release('7', null);

    expect(liveSlots('7')).toBe(1);
  });
});

describe('limiters without per-lease identity stay compatible', () => {
  test('the KV limiter accepts the extra argument and ignores it', async () => {
    const store = new Map<string, string>();
    const kv = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => {
        store.set(k, v);
      },
    } as unknown as KVNamespace;
    const limiter = new KvConcurrencyLimiter(kv);

    expect((await limiter.acquire('7', 2, 60, 'recall-a')).acquired).toBe(true);
    expect((await limiter.acquire('7', 2, 60, 'recall-a')).acquired).toBe(true);
    // No per-lease identity: the counter still increments per call, which is the
    // approximate behavior this fallback has always had.
    expect((await limiter.acquire('7', 2, 60, 'recall-a')).acquired).toBe(false);
  });

  test('the no-op limiter always admits', async () => {
    const limiter = new NoopConcurrencyLimiter();
    expect((await limiter.acquire()).acquired).toBe(true);
  });
});
