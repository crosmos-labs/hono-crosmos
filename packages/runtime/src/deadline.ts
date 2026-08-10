/**
 * Combine a caller's request deadline with an adapter's own safety timeout.
 *
 * These are two different guarantees and both are needed:
 *
 *  - the adapter timeout bounds a HUNG provider, so one wedged upstream call
 *    cannot pin an isolate indefinitely;
 *  - the caller deadline stops work the client has already ABANDONED. Without
 *    it, a search that has returned 504 to the client keeps holding provider
 *    and connection capacity for the remainder of the adapter timeout — which
 *    is precisely the invisible work that makes an overload self-sustaining.
 *
 * Replacing one with the other loses a guarantee, so this takes whichever
 * fires first.
 */
export function withDeadline(
  timeoutMs: number,
  signal?: AbortSignal,
): AbortSignal {
  const safety = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? safety : AbortSignal.any([signal, safety]);
}

/**
 * True when the failure was the caller's deadline rather than the adapter's own
 * timeout. Callers report these differently: an abandoned request is not a
 * provider fault and must not be logged or counted as one.
 */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}
