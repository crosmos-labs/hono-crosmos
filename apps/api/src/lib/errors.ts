import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { HonoEnv } from '../bindings';

/**
 * Canonical API error envelope. Every error response — validation failures,
 * thrown `HTTPException`s, the 500 fallback, and route-level custom errors —
 * goes through this shape so clients can parse one consistent thing.
 *
 * Design (least-breaking vs the old ad-hoc shapes):
 *  - `detail` is ALWAYS a human-readable string (it used to be variously a
 *    string, a Zod-flatten object, or `{error,message}` — clients broke on
 *    that). Structured data moves to siblings.
 *  - `code` is a stable, machine-readable error code (e.g. `rate_limited`,
 *    `validation_error`, `slug_taken`) for programmatic dispatch.
 *  - `request_id` is present on EVERY error body so clients that log bodies
 *    (not headers) can correlate to server traces.
 *  - `fields` carries validation field errors (Zod flatten) when relevant.
 *
 * Use `apiError(c, ...)` from routes and `errorEnvelope(...)` from the global
 * handlers in index.ts.
 */
export interface ErrorEnvelope {
  detail: string;
  code?: string;
  request_id?: string;
  fields?: Record<string, unknown>;
}

/**
 * Base class for domain errors that should map to a specific HTTP status and
 * machine code instead of a generic 500. The global `onError` handler in
 * index.ts recognizes any `AppError` and renders it through the canonical
 * envelope. Feature services should throw subclasses (or `new AppError(...)`)
 * for expected conditions (not-found, conflict, forbidden) rather than letting
 * a bare `Error` bubble up as a 500.
 */
export class AppError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function isAppError(err: unknown): err is AppError {
  return (
    err instanceof AppError ||
    (typeof err === 'object' &&
      err !== null &&
      typeof (err as { status?: unknown }).status === 'number' &&
      typeof (err as { code?: unknown }).code === 'string' &&
      typeof (err as { message?: unknown }).message === 'string')
  );
}

export function errorEnvelope(
  detail: string,
  opts: { code?: string; requestId?: string; fields?: Record<string, unknown> } = {},
): ErrorEnvelope {
  const body: ErrorEnvelope = { detail };
  if (opts.code !== undefined) body.code = opts.code;
  if (opts.requestId !== undefined) body.request_id = opts.requestId;
  if (opts.fields !== undefined) body.fields = opts.fields;
  return body;
}

/** Build a canonical error response for HTTP helpers that do not own a Hono context. */
export function errorResponse(
  status: number,
  detail: string,
  opts: {
    code?: string;
    requestId?: string;
    fields?: Record<string, unknown>;
    headers?: Record<string, string>;
  } = {},
): Response {
  return new Response(JSON.stringify(errorEnvelope(detail, opts)), {
    status,
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  });
}

/**
 * Build a consistent JSON error Response from a route. Pulls `request_id` from
 * the request context and mirrors it into the `X-Request-Id` header.
 */
export function apiError(
  c: Context<HonoEnv>,
  status: ContentfulStatusCode,
  detail: string,
  opts: {
    code?: string;
    fields?: Record<string, unknown>;
    headers?: Record<string, string>;
  } = {},
): Response {
  const requestId = c.var.requestId;
  const body = errorEnvelope(detail, {
    code: opts.code,
    requestId,
    fields: opts.fields,
  });
  return c.json(body, status, {
    ...(requestId ? { 'X-Request-Id': requestId } : {}),
    ...(opts.headers ?? {}),
  });
}
