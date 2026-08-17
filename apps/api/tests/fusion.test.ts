import { describe, expect, test } from 'bun:test';
import {
  computeRecency,
  computeRevisionAdjustment,
  shouldUseRecordedRecency,
} from '../src/features/search/fusion';

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

  test('distinguishes revisions from bare assertions for yes/no still queries', () => {
    const query = 'Do I still prefer a window seat?';
    expect(computeRevisionAdjustment(
      query,
      'User now needs an aisle seat instead of a window seat.',
    )).toBe(0.15);
    expect(computeRevisionAdjustment(
      query,
      'User prefers a window seat.',
    )).toBe(-0.25);
    expect(computeRevisionAdjustment(
      query,
      'User still prefers a window seat.',
    )).toBe(0.15);
  });

  test('does not adjust non-confirmation queries', () => {
    expect(computeRevisionAdjustment(
      'What kind of airplane seat do I currently need?',
      'User prefers a window seat.',
    )).toBe(0);
    expect(computeRevisionAdjustment(
      'Which book did I finish most recently?',
      'User finished Sea of Tranquility.',
    )).toBe(0);
  });
});
