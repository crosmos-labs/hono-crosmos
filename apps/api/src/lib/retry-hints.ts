/**
 * Server-driven client retry control.
 *
 * The Crosmos SDKs are Stainless-generated. Stainless's `shouldRetry` checks a
 * NON-STANDARD `x-should-retry` response header FIRST and obeys it verbatim,
 * before any status-code rule:
 *
 *   ../crosmos-ts-sdk/src/client.ts — shouldRetry()
 *     if (shouldRetryHeader === 'true')  return true;
 *     if (shouldRetryHeader === 'false') return false;
 *     ... then: 408 / 409 / 429 / >=500 all retry by default.
 *
 * That default is what turned the 2026-07-25 incident into a cascade: 45.20% of
 * search traffic was automatic retries, and they recovered only 5.08% of the
 * time. Concurrency 429s, provider-budget exhaustion, and CPU terminations are
 * all conditions an immediate retry makes strictly WORSE.
 *
 * Because the header is read by the ALREADY-SHIPPED client, the server can shut
 * the retry storm off unilaterally — no SDK release, no customer upgrade. This
 * matters: Stainless is being wound down and the SDKs are not yet migrated, so
 * a server-side lever is the only one we can actually pull today.
 *
 * `Retry-After` is set alongside it for the cases where a LATER retry is fine.
 * Stainless honors that too (`retryAfterHeader`), and it is the standard signal
 * every other HTTP client understands.
 */

/** Response headers instructing a Stainless client not to retry at all. */
export const NO_RETRY_HEADERS: Record<string, string> = {
  'x-should-retry': 'false',
};

/**
 * Headers for "this will succeed later, but not right now". Sets an explicit
 * `Retry-After` so the client backs off by a known amount instead of hammering
 * immediately, and leaves `x-should-retry` unset so status-code defaults apply.
 */
export function retryAfterHeaders(seconds: number): Record<string, string> {
  return { 'Retry-After': String(seconds) };
}

/**
 * Headers for a condition that is deterministic for some period: do not retry
 * this request, and here is when the condition is expected to clear. Used for
 * provider-budget exhaustion, where every retry before the renewal time is
 * guaranteed to fail and merely adds load to a dependency already refusing work.
 */
export function noRetryUntilHeaders(seconds: number): Record<string, string> {
  return { ...NO_RETRY_HEADERS, 'Retry-After': String(seconds) };
}
