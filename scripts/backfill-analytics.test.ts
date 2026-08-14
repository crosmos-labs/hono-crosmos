import { describe, expect, test } from 'bun:test';
import { parseArgs } from './backfill-analytics';

describe('backfill-analytics arguments', () => {
  test('requires an explicit dry-run or apply choice', () => {
    expect(() => parseArgs(['--from', '2026-07-01', '--to', '2026-07-31'])).toThrow();
    expect(() => parseArgs(['--from', '2026-07-01', '--to', '2026-07-31', '--dry-run', '--apply'])).toThrow();
  });
  test('accepts an inclusive bounded range', () => {
    expect(parseArgs(['--from', '2026-07-01', '--to', '2026-07-31', '--dry-run'])).toEqual({
      from: '2026-07-01', to: '2026-07-31', apply: false,
    });
  });
});
