import { describe, expect, test } from 'bun:test';
import { computeRecency, shouldUseRecordedRecency } from '../src/features/search/fusion';

describe('current-information recency', () => {
  test('uses recorded time only for explicit updates to current-information queries', () => {
    expect(shouldUseRecordedRecency(
      'Who currently leads Cedar Phoenix?',
      'Omar Haddad replaced Alina Rao as lead.',
    )).toBe(true);
    expect(shouldUseRecordedRecency(
      'Who leads Cedar Phoenix?',
      'Omar Haddad replaced Alina Rao as lead.',
    )).toBe(false);
    expect(shouldUseRecordedRecency(
      'Who currently leads Cedar Phoenix?',
      'Project Cedar Phoenix is led by Alina Rao.',
    )).toBe(false);
  });

  test('keeps undated memories neutral unless the caller opts in', () => {
    const recordedAt = new Date('2026-07-01T00:00:00Z');
    const now = new Date('2026-08-01T00:00:00Z');

    expect(computeRecency(now, recordedAt, null, now)).toBe(0.5);
    expect(computeRecency(now, recordedAt, null, now, true)).toBeCloseTo(
      1 - 31 / 365,
    );
  });

  test('event time remains authoritative when recorded-time opt-in is enabled', () => {
    const eventTime = new Date('2025-08-01T00:00:00Z');
    const recordedAt = new Date('2026-07-01T00:00:00Z');
    const now = new Date('2026-08-01T00:00:00Z');

    expect(computeRecency(now, recordedAt, eventTime, now, true)).toBe(0.2);
  });
});
