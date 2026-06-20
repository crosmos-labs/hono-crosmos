import { describe, expect, test } from 'bun:test';
import { fuzzyExtract, tokenSortRatio } from '../src/extractors/fuzzy';

interface Candidate {
  id: number;
  name: string;
}

const candidateName = (candidate: Candidate): string => candidate.name;

describe('tokenSortRatio', () => {
  test('scores reordered tokens as an exact match', () => {
    expect(tokenSortRatio('Anthropic Inc', 'Inc Anthropic')).toBe(100);
  });
});

describe('fuzzyExtract', () => {
  test('returns the best object matches above the cutoff', () => {
    const choices: Candidate[] = [
      { id: 1, name: 'OpenAI' },
      { id: 2, name: 'Inc Anthropic' },
      { id: 3, name: 'Anthropic Labs' },
    ];

    const matches = fuzzyExtract('Anthropic Inc', choices, candidateName, {
      limit: 2,
      scoreCutoff: 60,
    });

    expect(matches).toHaveLength(2);
    expect(matches[0]).toEqual({ choice: choices[1]!, score: 100 });
    expect(matches[1]!.choice).toBe(choices[2]!);
    expect(matches[1]!.score).toBeGreaterThanOrEqual(60);
  });

  test('applies the score cutoff before returning matches', () => {
    const choices: Candidate[] = [
      { id: 1, name: 'Inc Anthropic' },
      { id: 2, name: 'Anthropic Labs' },
      { id: 3, name: 'OpenAI' },
    ];

    const matches = fuzzyExtract('Anthropic Inc', choices, candidateName, {
      limit: 10,
      scoreCutoff: 95,
    });

    expect(matches).toEqual([{ choice: choices[0]!, score: 100 }]);
  });

  test('respects the requested limit', () => {
    const choices: Candidate[] = [
      { id: 1, name: 'Inc Anthropic' },
      { id: 2, name: 'Anthropic Inc' },
    ];

    const matches = fuzzyExtract('Anthropic Inc', choices, candidateName, {
      limit: 1,
      scoreCutoff: 0,
    });

    expect(matches).toHaveLength(1);
  });

  test('keeps input order for tied scores', () => {
    const choices: Candidate[] = [
      { id: 1, name: 'beta alpha' },
      { id: 2, name: 'alpha beta' },
    ];

    const matches = fuzzyExtract('alpha beta', choices, candidateName, {
      limit: 2,
      scoreCutoff: 0,
    });

    expect(matches.map((match) => match.choice.id)).toEqual([1, 2]);
    expect(matches.map((match) => match.score)).toEqual([100, 100]);
  });
});
