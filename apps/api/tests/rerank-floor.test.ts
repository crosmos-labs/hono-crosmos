import { describe, expect, test } from 'bun:test';
import { applyRelevanceFloor } from '../src/features/search/service';
import { rerankRelevanceFloor } from '../src/features/search/constants';
import type { CandidateMemory } from '../src/features/search/types';
import calibration from './fixtures/rerank-floor-calibration.json';

/**
 * Regression test for the post-rerank relevance floor, replayed against raw
 * Voyage rerank-2.5 scores recorded from production on 2026-08-19.
 *
 * A threshold constant cannot be reviewed in isolation — 0.4 is only correct
 * relative to where real gold and real noise actually land. These tests pin the
 * calibration to that measured distribution, so raising the floor until it
 * starts eating gold, or lowering it until noise returns, fails here.
 */

const FLOOR = rerankRelevanceFloor('rerank-2.5')!;

/** Minimal candidate carrying the only field the floor reads. */
function scored(rerankScore: number, id: number): CandidateMemory {
  return { rerankScore, memoryId: id } as unknown as CandidateMemory;
}

/** One recorded search, as the pool the floor sees (gold + noise together). */
function pool(c: { gold: number[]; noise: number[] }): CandidateMemory[] {
  const all = [...c.gold.map((s) => ({ s, gold: true })), ...c.noise.map((s) => ({ s, gold: false }))];
  all.sort((a, b) => b.s - a.s);
  return all.map((x, i) => scored(x.s, x.gold ? i : -i - 1));
}
const isGold = (c: CandidateMemory) => c.memoryId >= 0;

const positives = calibration.cases.filter((c) => c.label === 'positive' && c.gold.length > 0);
const negatives = calibration.cases.filter((c) => c.label === 'negative' && c.noise.length > 0);

describe('rerank relevance floor, replayed on recorded production scores', () => {
  test('the fixture is the measured corpus it claims to be', () => {
    expect(calibration.model).toBe('rerank-2.5');
    expect(positives.length).toBe(44);
    expect(negatives.length).toBeGreaterThanOrEqual(47);
  });

  test('every positive query keeps at least one gold memory', () => {
    const lost = positives.filter((c) => !applyRelevanceFloor(pool(c), FLOOR).some(isGold));
    expect(lost.map((c) => c.query)).toEqual([]);
  });

  test('it silences the large majority of off-topic queries entirely', () => {
    const silenced = negatives.filter((c) => applyRelevanceFloor(pool(c), FLOOR).length === 0);
    // Measured 40/47 at 0.4. The survivors are entity-overlapping probes such
    // as "what allergies does my dog have?" against a corpus of allergy facts,
    // where returning something is defensible.
    expect(silenced.length / negatives.length).toBeGreaterThan(0.7);
  });

  test('it removes almost all irrelevant results overall', () => {
    let before = 0;
    let after = 0;
    for (const c of negatives) {
      before += c.noise.length;
      after += applyRelevanceFloor(pool(c), FLOOR).length;
    }
    expect(before).toBeGreaterThan(300);
    expect(after / before).toBeLessThan(0.05);
  });

  test('the reported single-memory false positive returns nothing', () => {
    // "why are there two theems for catpuccin? one in static and one in
    // normal" against a space whose only memory is about Genshin Impact.
    // Voyage scored it 0.1904. This is the case that prompted the fix.
    const reported = calibration.cases.find((c) => c.query.startsWith('why are there two theems'));
    expect(reported).toBeDefined();
    expect(applyRelevanceFloor(pool(reported!), FLOOR)).toEqual([]);
  });

  test('an empty result is representable — no candidate is force-kept', () => {
    // The previous implementation fell back to `scored.slice(0, 1)` whenever
    // nothing cleared the floor, which made the gate a no-op for exactly the
    // single-memory space that reported the bug.
    expect(applyRelevanceFloor([scored(0.19, 1)], FLOOR)).toEqual([]);
  });

  test('recall breaks above 0.5, which is why the floor sits below it', () => {
    const lostAt = (f: number) =>
      positives.filter((c) => !applyRelevanceFloor(pool(c), f).some(isGold)).length;
    expect(lostAt(FLOOR)).toBe(0);
    expect(lostAt(0.5)).toBeGreaterThan(0);
  });
});
