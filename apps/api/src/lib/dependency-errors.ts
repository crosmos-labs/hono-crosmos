/**
 * Classification of database/provider failures into stable, machine-readable
 * responses.
 *
 * During the 2026-07-25 incident the Postgres provider began refusing work with
 *
 *   > Usage limit for account exceeded, usage renews at 2026-07-26 00:00:00 UTC
 *
 * 4,616 times. Every one of them fell through to the top-level handler and
 * became `api.unhandled_error` → a generic HTTP 500. Three things followed from
 * that single missing classification:
 *
 *   1. the client saw a 500 and, per the Stainless default, retried immediately
 *      — against a dependency that had already stated it would not recover until
 *      a fixed time;
 *   2. alerting saw "unhandled application error" rather than "provider budget
 *      exhausted", so the actual cause was invisible;
 *   3. the condition was indistinguishable from a real code defect.
 *
 * Two distinct conditions are separated here because they want opposite client
 * behavior. Capacity exhaustion is DETERMINISTIC until a known renewal time, so
 * no retry can help and the client is told not to. A dropped connection is
 * transient, so a delayed retry is exactly right.
 */

/** Machine-readable dependency failure codes, returned as `code` in the envelope. */
export type DependencyFailureCode =
  | 'database_capacity_unavailable'
  | 'database_temporarily_unavailable';

export interface DependencyFailure {
  code: DependencyFailureCode;
  /** Always 503: the service is fine, a dependency it needs is not. */
  status: 503;
  /** Client-safe message. Never the raw provider text. */
  detail: string;
  /** Seconds to wait before the condition could plausibly have cleared. */
  retryAfterSeconds: number;
  /** True when retrying before `retryAfterSeconds` provably cannot succeed. */
  deterministic: boolean;
  /** Low-cardinality label for metrics/alerting. */
  dependency: 'database';
}

/**
 * Provider messages meaning "your account is out of allowance". Matched
 * case-insensitively on the error message, which is the only signal the driver
 * surfaces — neither Neon nor Hyperdrive maps this to a distinct SQLSTATE.
 */
const CAPACITY_PATTERNS = [
  /usage limit for account exceeded/i,
  /quota (?:has been )?exceeded/i,
  /exceeded .{0,40}\b(?:compute|storage|data transfer) (?:limit|quota)/i,
];

/**
 * Messages meaning "the connection dropped". These are the 60 `Network
 * connection lost` rows and the four `hyperdrive.local:5432` connection-closed
 * rows from the same 72-hour review.
 */
const TRANSIENT_PATTERNS = [
  /network connection lost/i,
  // postgres.js reports these as underscore-joined codes
  // (`write CONNECTION_CLOSED hyperdrive.local:5432`), so the separator must
  // match `_` as well as a space.
  /connection[ _](?:terminated|closed|ended|destroyed|reset|connect_timeout)/i,
  /ECONNRESET|EPIPE|ETIMEDOUT/i,
  /terminating connection due to/i,
];

/**
 * Neon states its renewal time in the message. When present, use it to return an
 * ACCURATE `Retry-After` instead of a guess — the client then comes back when
 * the budget has actually reset rather than probing a dependency that is
 * certain to refuse.
 */
const RENEWAL_PATTERN = /usage renews at ([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9:]+)\s*(UTC)?/i;

/** Floor/ceiling on any advertised `Retry-After`, in seconds. */
const MIN_RETRY_AFTER = 60;
const MAX_RETRY_AFTER = 3600;

function messageOf(err: unknown): string {
  if (err instanceof Error) {
    // postgres.js nests the server error; include both so a wrapped error still
    // matches.
    const cause = (err as { cause?: unknown }).cause;
    const causeMsg = cause instanceof Error ? ` ${cause.message}` : '';
    return `${err.message}${causeMsg}`;
  }
  return typeof err === 'string' ? err : '';
}

/** Seconds until the provider's stated renewal time, clamped to sane bounds. */
function retryAfterFromRenewal(message: string, now: number): number {
  const match = RENEWAL_PATTERN.exec(message);
  if (!match) return MAX_RETRY_AFTER;
  // The provider reports UTC; normalize so this is not parsed as local time.
  const iso = `${match[1]!.replace(' ', 'T')}Z`;
  const renewal = Date.parse(iso);
  if (Number.isNaN(renewal)) return MAX_RETRY_AFTER;
  const seconds = Math.ceil((renewal - now) / 1000);
  return Math.min(MAX_RETRY_AFTER, Math.max(MIN_RETRY_AFTER, seconds));
}

/**
 * Classify an error as a known database dependency failure, or return `null` to
 * let it be handled as an ordinary unexpected error.
 *
 * Deliberately conservative: anything not matching a known provider condition
 * stays a 500, so a genuine defect is never disguised as a dependency problem.
 */
export function classifyDependencyError(
  err: unknown,
  now: number = Date.now(),
): DependencyFailure | null {
  const message = messageOf(err);
  if (message === '') return null;

  if (CAPACITY_PATTERNS.some((p) => p.test(message))) {
    return {
      code: 'database_capacity_unavailable',
      status: 503,
      detail:
        'The service is temporarily unable to reach its database. Please retry later.',
      retryAfterSeconds: retryAfterFromRenewal(message, now),
      deterministic: true,
      dependency: 'database',
    };
  }

  if (TRANSIENT_PATTERNS.some((p) => p.test(message))) {
    return {
      code: 'database_temporarily_unavailable',
      status: 503,
      detail: 'The service is temporarily unavailable. Please retry shortly.',
      retryAfterSeconds: MIN_RETRY_AFTER,
      deterministic: false,
      dependency: 'database',
    };
  }

  return null;
}
