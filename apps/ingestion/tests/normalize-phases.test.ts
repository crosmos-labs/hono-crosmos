import { describe, expect, test } from 'bun:test';
import {
  attachGraphToFacts,
  DropCounter,
  normalizeBaseFacts,
  normalizeFacts,
  parseIsoDate,
} from '../src/extractors/normalize';
import type { RawExtractedMemory, RawGraphResult } from '../src/extractors/types';

const raw: RawExtractedMemory[] = [{
  content: 'Alice finished the migration yesterday',
  memory_type: 'episode',
  importance_score: 0.8,
  speaker_role: 'user',
  event_time: null,
}];

const graph: RawGraphResult[] = [{
  index: 0,
  entities: [
    { name: 'Alice', entity_type: 'person' },
    { name: 'Migration', entity_type: 'project' },
  ],
  relations: [{
    subject: 'Alice', relation: 'finished', object: 'Migration',
    confidence: 0.9, valid_from: null,
  }],
}];

describe('phased normalization', () => {
  test('interprets provider ISO timestamps without offsets as UTC', () => {
    expect(parseIsoDate('2026-06-01T00:00:00')?.toISOString())
      .toBe('2026-06-01T00:00:00.000Z');
    expect(parseIsoDate('2026-06-01T00:00:00+05:30')?.toISOString())
      .toBe('2026-05-31T18:30:00.000Z');
  });

  test('matches the combined normalization result before temporal fallback', () => {
    const combined = normalizeFacts(raw, graph, new DropCounter());
    const base = normalizeBaseFacts(raw, new DropCounter());
    const phased = attachGraphToFacts(base, raw.length, graph, new DropCounter());
    expect(phased).toEqual(combined);
  });

  test('does not leak the later regex fallback into relation valid_from', () => {
    const base = normalizeBaseFacts(raw, new DropCounter());
    base[0]!.fact.eventTime = new Date('2026-08-13T00:00:00Z');
    const [fact] = attachGraphToFacts(base, raw.length, graph, new DropCounter());
    expect(fact?.eventTime?.toISOString()).toBe('2026-08-13T00:00:00.000Z');
    expect(fact?.relations[0]?.validFrom).toBeNull();
  });
});
