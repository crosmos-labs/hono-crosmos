import type { Context, Next } from 'hono';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import type { HonoEnv } from '../../bindings';
import { getCachedMembership } from '../../lib/gate-cache';

/**
 * Mirrors Python's `get_current_principal`: assumes `requireAuth` has already
 * populated user context. Re-verifies that the authenticated user is a member
 * of the active org (re-checking on every request, not trusting the token
 * blindly — this is the same behavior as Python). Sets `orgRole` on context.
 *
 * - JWT path: `activeOrgId` comes from the `active_org_id` claim. If missing,
 *   400 "no_org_context" (matches Python).
 * - API key path: `activeOrgId` is the key's pinned org.
 *
 * If the user is no longer a member of that org → 404 "Organization not found".
 */
export const requirePrincipal = createMiddleware<HonoEnv>(async (c, next) => {
  if (c.var.userId == null) {
    throw new HTTPException(401, { message: 'Unauthenticated' });
  }
  if (c.var.activeOrgId == null) {
    throw new HTTPException(400, { message: 'no_org_context' });
  }
  const member = await getCachedMembership(c, c.var.activeOrgId, c.var.userId);
  if (!member) {
    throw new HTTPException(404, { message: 'Organization not found' });
  }
  c.set('orgRole', member.role);
  c.set('activeOrgUuid', member.orgUuid);
  await next();
});

/**
 * Wraps `requirePrincipal` and enforces the principal's role is in `allowed`.
 * Mirrors Python's `require_principal_role(*allowed)`.
 */
export function requireRole(...allowed: Array<'owner' | 'admin' | 'member'>) {
  return createMiddleware<HonoEnv>(async (c, next) => {
    // Run principal check first (composing middleware inline for simplicity).
    await requirePrincipal(c as Context<HonoEnv>, (async () => {}) as Next);
    const role = c.var.orgRole;
    if (!role || !allowed.includes(role)) {
      throw new HTTPException(403, { message: 'insufficient_role' });
    }
    await next();
  });
}
