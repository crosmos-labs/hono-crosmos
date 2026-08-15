import { describe, expect, test } from 'bun:test';
import { buildQuery, extractEvents, parseArgs } from './query-workers-logs';

describe('query-workers-logs', () => {
  test('builds a one-day request-id query', () => {
    const previousAccountId = Bun.env.CLOUDFLARE_ACCOUNT_ID;
    const previousToken = Bun.env.CLOUDFLARE_API_TOKEN;
    Bun.env.CLOUDFLARE_ACCOUNT_ID = 'account';
    Bun.env.CLOUDFLARE_API_TOKEN = 'token';
    try {
      const options = parseArgs(
        ['--request-id', 'request-123', '--script', 'crosmos-api-production'],
        Date.UTC(2026, 7, 14),
      );
      expect(options).not.toBe('help');
      if (options === 'help') return;
      expect(options.from).toBe(Date.UTC(2026, 7, 13));
      expect(options.to).toBe(Date.UTC(2026, 7, 14));
      expect(buildQuery(options)).toMatchObject({
        view: 'events',
        dry: true,
        parameters: {
          filters: [
            {
              key: '$workers.scriptName',
              operation: 'eq',
              value: 'crosmos-api-production',
            },
          ],
          needle: { value: 'request-123' },
        },
      });
    } finally {
      Bun.env.CLOUDFLARE_ACCOUNT_ID = previousAccountId;
      Bun.env.CLOUDFLARE_API_TOKEN = previousToken;
    }
  });

  test('rejects multiple selectors', () => {
    expect(() =>
      parseArgs(['--request-id', 'one', '--event', 'http.request']),
    ).toThrow('Use one search selector');
  });

  test('help does not require credentials', () => {
    expect(parseArgs(['--help'])).toBe('help');
  });

  test('extracts events from current and enveloped Cloudflare responses', () => {
    const events = [{ id: 'event-1' }];
    expect(extractEvents({ events })).toEqual(events);
    expect(extractEvents({ events: { events } })).toEqual(events);
    expect(extractEvents({ result: { events } })).toEqual(events);
    expect(extractEvents({ result: { events: { events } } })).toEqual(events);
    expect(extractEvents({ result: events })).toEqual(events);
    expect(() => extractEvents({ result: { fields: [] } })).toThrow('unexpected response shape');
  });
});
