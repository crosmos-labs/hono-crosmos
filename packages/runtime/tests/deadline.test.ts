/**
 * P1-C — combining a caller deadline with an adapter safety timeout.
 *
 * These are two different guarantees and the combination must keep both: the
 * adapter timeout bounds a hung provider, the caller deadline stops work the
 * client has abandoned. Replacing one with the other silently loses a
 * protection, so the cases below pin which signal wins in each direction.
 */
import { describe, expect, test } from 'bun:test';
import { isAbortError, withDeadline } from '../src/deadline';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('withDeadline', () => {
  test('with no caller signal it is just the safety timeout', async () => {
    const signal = withDeadline(20);
    expect(signal.aborted).toBe(false);
    await tick(50);
    expect(signal.aborted).toBe(true);
  });

  test('the caller deadline wins when it fires first', async () => {
    const caller = new AbortController();
    const signal = withDeadline(10_000, caller.signal);

    expect(signal.aborted).toBe(false);
    caller.abort();
    // Same tick — no need to wait out the (much longer) safety timeout.
    await tick(0);
    expect(signal.aborted).toBe(true);
  });

  test('the safety timeout still fires when the caller never aborts', async () => {
    const caller = new AbortController();
    const signal = withDeadline(20, caller.signal);

    await tick(60);
    expect(signal.aborted).toBe(true);
    // The caller signal itself is untouched — combining must not abort it.
    expect(caller.signal.aborted).toBe(false);
  });

  test('an already-aborted caller signal produces an already-aborted result', () => {
    const caller = new AbortController();
    caller.abort();
    expect(withDeadline(10_000, caller.signal).aborted).toBe(true);
  });

  test('combining does not mutate the caller signal', async () => {
    const caller = new AbortController();
    withDeadline(5, caller.signal);
    await tick(40);
    expect(caller.signal.aborted).toBe(false);
  });
});

describe('isAbortError', () => {
  test('recognises a caller abort', async () => {
    const caller = new AbortController();
    caller.abort();
    try {
      await fetch('https://example.invalid', { signal: caller.signal });
      throw new Error('expected the fetch to reject');
    } catch (err) {
      expect(isAbortError(err)).toBe(true);
    }
  });

  test('does not classify a timeout as a caller abort', () => {
    // A safety-timeout abort surfaces as TimeoutError and must stay a provider
    // fault: it is retryable, whereas an abandoned request is not worth retrying.
    const timeoutError = new DOMException('timed out', 'TimeoutError');
    expect(isAbortError(timeoutError)).toBe(false);
  });

  test('does not classify ordinary errors as aborts', () => {
    expect(isAbortError(new Error('boom'))).toBe(false);
    expect(isAbortError('boom')).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });
});
