import { describe, expect, test } from 'bun:test';
import { resolveSessionTemporalContext } from '../src/ingestion/pipeline';

describe('session temporal context', () => {
  test('uses one UTC instant for extraction, fallback, and persistence', () => {
    const context = resolveSessionTemporalContext('2026-06-01T00:00:00');

    expect(context.referenceTime).toBe('2026-06-01T00:00:00.000Z');
    expect(context.temporalBase?.toISOString()).toBe(context.referenceTime);
    expect(context.recordedAt.toISOString()).toBe(context.referenceTime);
  });

  test('preserves an explicit caller offset', () => {
    const context = resolveSessionTemporalContext('2026-06-01T00:00:00+05:30');

    expect(context.referenceTime).toBe('2026-05-31T18:30:00.000Z');
    expect(context.temporalBase?.toISOString()).toBe(context.referenceTime);
    expect(context.recordedAt.toISOString()).toBe(context.referenceTime);
  });

  test('falls back consistently when the session date is invalid', () => {
    const fallback = new Date('2026-08-15T12:34:56.000Z');
    const context = resolveSessionTemporalContext('not-a-date', fallback);

    expect(context.referenceTime).toBeNull();
    expect(context.temporalBase).toBeNull();
    expect(context.recordedAt).toBe(fallback);
  });
});
