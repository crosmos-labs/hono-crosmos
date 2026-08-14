import { describe, expect, test } from 'bun:test';
import {
  buildPrivateTimingQuery,
  extractRetrievalTimings,
  fetchPrivateRetrievalTimings,
} from './private-retrieval-timing';

describe('private retrieval timing', () => {
  test('extracts direct, source, and string-wrapped structured records', () => {
    const events = [
      { source: { event: 'retrieval.request_completed', request_id: 'one', duration_ms: 12.5 } },
      { source: JSON.stringify({ event: 'retrieval.request_completed', request_id: 'two', duration_ms: 42 }) },
      { source: { message: JSON.stringify({ event: 'retrieval.request_completed', request_id: 'three', duration_ms: 7 }) } },
      { source: { event: 'retrieval.stage_completed', request_id: 'one', duration_ms: 999 } },
      { source: { event: 'retrieval.request_completed', request_id: 'other', duration_ms: 1 } },
    ];
    expect([...extractRetrievalTimings(events, ['one', 'two', 'three'])]).toEqual([
      ['one', 12.5],
      ['two', 42],
      ['three', 7],
    ]);
  });

  test('builds a bounded private event query', () => {
    expect(buildPrivateTimingQuery({
      from: 10,
      to: 20,
      scriptName: 'crosmos-api-production',
      requestIds: ['request.one', 'request-two'],
    })).toMatchObject({
      timeframe: { from: 10, to: 20 },
      view: 'events',
      limit: 100,
      parameters: {
        filters: [{ value: 'crosmos-api-production' }],
        needle: {
          value: 'request\\.one|request-two',
          isRegex: true,
          matchCase: true,
        },
      },
    });
  });

  test('rejects an empty private timing query', () => {
    expect(() => buildPrivateTimingQuery({
      from: 10,
      to: 20,
      requestIds: [],
    })).toThrow('requires at least one request id');
  });

  test('fails explicitly when Cloudflare rejects the private query', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      success: false,
      errors: [{ message: 'forbidden' }],
    }), { status: 403 })) as typeof fetch;
    await expect(fetchPrivateRetrievalTimings({
      accountId: 'account',
      apiToken: 'token',
      requestIds: ['one'],
      from: 10,
      to: 20,
    }, fetchImpl)).rejects.toThrow('Cloudflare private timing query failed (403): forbidden');
  });
});
