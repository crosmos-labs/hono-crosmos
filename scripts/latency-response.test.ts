import { describe, expect, test } from 'bun:test';
import { readServerTookMs } from './latency-response';

describe('readServerTookMs', () => {
  test('reads a finite non-negative duration', () => {
    expect(readServerTookMs(new Headers({ 'X-Crosmos-Took-Ms': '123.45' }))).toBe(
      123.45,
    );
  });

  test('fails loudly when the header is absent', () => {
    expect(() => readServerTookMs(new Headers())).toThrow(
      'missing X-Crosmos-Took-Ms',
    );
  });

  test('rejects invalid values', () => {
    expect(() =>
      readServerTookMs(new Headers({ 'X-Crosmos-Took-Ms': 'NaN' })),
    ).toThrow('Invalid X-Crosmos-Took-Ms');
    expect(() =>
      readServerTookMs(new Headers({ 'X-Crosmos-Took-Ms': '-1' })),
    ).toThrow('Invalid X-Crosmos-Took-Ms');
  });
});
