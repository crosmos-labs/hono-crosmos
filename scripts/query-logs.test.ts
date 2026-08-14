import { afterEach, describe, expect, test } from 'bun:test';
import { buildQuery, parseArgs } from './query-logs';

const oldBucket = Bun.env.R2_LOG_BUCKET;
const oldTemplate = Bun.env.R2_LOG_OBJECT_TEMPLATE;

afterEach(() => {
  Bun.env.R2_LOG_BUCKET = oldBucket;
  Bun.env.R2_LOG_OBJECT_TEMPLATE = oldTemplate;
});

describe('query-logs', () => {
  test('expands each UTC archive partition and escapes filter text', () => {
    const options = parseArgs([
      '--from', '2026-08-01',
      '--to', '2026-08-02',
      '--event', "api.o'hare",
    ]);
    expect(options).not.toBe('help');
    if (options === 'help') return;
    const sql = buildQuery(options);
    expect(sql).toContain('20260801*.gz');
    expect(sql).toContain('20260802*.gz');
    expect(sql).toContain("api.o''hare");
    expect(sql).toContain('ORDER BY event_timestamp_ms, script_name');
  });

  test('requires a bounded range and at least one filter', () => {
    expect(() => parseArgs(['--from', '2026-08-01', '--to', '2026-08-02'])).toThrow();
    expect(() => parseArgs([
      '--from', '2026-01-01', '--to', '2026-08-02', '--level', 'error',
    ])).toThrow('at most 91 days');
  });

  test('count mode does not add an ordering pass', () => {
    const options = parseArgs([
      '--from', '2026-08-01T00:00:00Z',
      '--to', '2026-08-01T01:00:00Z',
      '--level', 'error',
      '--count',
    ]);
    if (options === 'help') throw new Error('unexpected help');
    const sql = buildQuery(options);
    expect(sql).toContain('count(*) AS matching_invocations');
    expect(sql).not.toContain('ORDER BY');
  });
});
