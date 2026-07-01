import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { HonoEnv } from '../bindings';

/**
 * Enforce a space-scoped API key's boundary on the data plane.
 *
 * When the authenticating API key is pinned to a space (`c.var.scopedSpaceId`
 * is set — see auth middleware), every ingest/search/source request must target
 * that same space. A request for any other space is rejected with 403.
 *
 * No-op for JWT auth and org-wide keys (`scopedSpaceId` undefined), so existing
 * callers are unaffected.
 *
 * `resolvedSpaceId` is the integer id of the space the request actually resolved
 * to (after the normal org-ownership / existence checks). Call this AFTER those
 * checks so cross-tenant access still surfaces as 404, not 403.
 */
export function assertKeyScopeAllowsSpace(
  c: Context<HonoEnv>,
  resolvedSpaceId: number,
): void {
  const scoped = c.var.scopedSpaceId;
  if (scoped != null && scoped !== resolvedSpaceId) {
    throw new HTTPException(403, {
      message: 'This API key is scoped to a different memory space.',
    });
  }
}

/**
 * For list-style endpoints that accept an OPTIONAL space filter: returns the
 * space id a space-scoped key must be constrained to, or `undefined` for
 * unscoped auth. Callers fold this into their query filter so a scoped key can
 * never enumerate other spaces' data.
 */
export function keyScopeSpaceId(c: Context<HonoEnv>): number | undefined {
  return c.var.scopedSpaceId;
}
