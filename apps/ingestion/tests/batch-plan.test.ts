import { describe, expect, test } from 'bun:test';
import { planBatch } from '../src/ingestion/pipeline';

/**
 * `planBatch` is the resume arithmetic for the batched, checkpointed pipeline
 * (issue #9 — the fix for the source-520 stall where a large source could never
 * finish in one Cloudflare invocation). An off-by-one here either re-processes a
 * chunk (duplicate work) or skips one (lost memories), so it's covered directly.
 */
describe('planBatch', () => {
  test('fresh source, budget covers everything → one complete batch', () => {
    expect(planBatch(5, 0, 8)).toEqual({ start: 0, end: 5, remaining: 0 });
  });

  test('fresh source larger than budget → first batch, remainder tracked', () => {
    // The source-520 shape: 16 chunks, budget 8.
    expect(planBatch(16, 0, 8)).toEqual({ start: 0, end: 8, remaining: 8 });
  });

  test('resume from checkpoint → next window, no gap or overlap', () => {
    expect(planBatch(16, 8, 8)).toEqual({ start: 8, end: 16, remaining: 0 });
  });

  test('resume where the final batch is smaller than the budget', () => {
    expect(planBatch(20, 16, 8)).toEqual({ start: 16, end: 20, remaining: 0 });
  });

  test('a large source resumes across many budget-sized windows with full coverage', () => {
    const total = 37;
    const budget = 8;
    let seq = 0;
    const covered: number[] = [];
    // Simulate successive invocations until complete; guard against a runaway.
    for (let guard = 0; guard < 100 && seq < total; guard++) {
      const plan = planBatch(total, seq, budget);
      for (let i = plan.start; i < plan.end; i++) covered.push(i);
      expect(plan.end).toBeGreaterThan(plan.start); // always makes progress
      seq = plan.end;
    }
    // Every chunk processed exactly once, in order, none skipped or repeated.
    expect(covered).toEqual(Array.from({ length: total }, (_, i) => i));
  });

  test('checkpoint already at the end → nothing to do, complete', () => {
    expect(planBatch(10, 10, 8)).toEqual({ start: 10, end: 10, remaining: 0 });
  });

  test('no budget this invocation → empty batch, remainder preserved for re-queue', () => {
    expect(planBatch(16, 4, 0)).toEqual({ start: 4, end: 4, remaining: 12 });
  });

  test('single-chunk source (the common small case) completes in one batch', () => {
    expect(planBatch(1, 0, 8)).toEqual({ start: 0, end: 1, remaining: 0 });
  });

  test('defensive clamping: checkpoint past the end never yields a negative range', () => {
    // e.g. source was re-chunked shorter after a checkpoint was written.
    expect(planBatch(5, 9, 8)).toEqual({ start: 5, end: 5, remaining: 0 });
  });

  test('defensive clamping: negative / fractional inputs are floored into range', () => {
    expect(planBatch(10, -3, 4)).toEqual({ start: 0, end: 4, remaining: 6 });
    expect(planBatch(10, 2.9, 3.9)).toEqual({ start: 2, end: 5, remaining: 5 });
  });
});
