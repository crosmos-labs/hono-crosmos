/**
 * Read-through cache for the per-request "gate" reads that change rarely:
 * org entitlements, org membership, and space-by-uuid. Backed by the
 * configured `CacheStore` under a `gate:` prefix.
 *
 * On free-tier / cross-region Neon each of these is a ~150–200ms round-trip, so
 * caching them removes a big chunk of the pre-retrieval gate latency.
 *
 * Correctness rules:
 *  - **Negative results are NOT cached** (a missing membership/space returns
 *    null without writing), so newly-added members or spaces are never locked
 *    out by a stale "not found".
 *  - **Short TTLs** bound staleness (KV minimum is 60s). Entitlements get 300s
 *    (plans change rarely); membership/space get 60s (authz freshness).
 *  - **Explicit invalidation** is the source of immediacy. Any code that
 *    MUTATES one of these MUST call the matching `invalidate*`:
 *      · org plan / entitlements change → `invalidateEntitlements(env, orgId)`
 *      · member added / removed / role changed → `invalidateMembership(env, orgId, userId)`
 *      · space deleted (or its org/scope changed) → `invalidateSpace(env, uuid)`
 *    (Today the codebase only adds members and creates/deletes spaces, and
 *    never mutates plan in-code, so the TTL alone is already correct — these
 *    hooks future-proof the invariant. See the call sites that use them.)
 *  - **Fails open**: any KV error falls back to a direct DB read.
 */
import type { Context } from 'hono';
import { createLogger } from '@crosmos/observability';
import type { Env, HonoEnv } from '../bindings';
import { getDb } from '../db';
import { getCacheStore } from '../integrations/cache';
import { getBackgroundTasks } from './runtime';
import { type Entitlements, getEntitlements } from '../features/orgs/entitlements';
import { getMembership, type MembershipRow } from '../features/orgs/memberships';
import { getSpaceByUuid } from '../features/spaces/service';

// All ≥ 60s — Cloudflare KV's minimum expirationTtl.
const ENTITLEMENTS_TTL_SECONDS = 300;
const MEMBERSHIP_TTL_SECONDS = 60;
const SPACE_TTL_SECONDS = 60;

const entKey = (orgId: number) => `gate:ent:${orgId}`;
const memberKey = (orgId: number, userId: number) => `gate:member:${orgId}:${userId}`;
const spaceKey = (uuid: string) => `gate:space:${uuid}`;

/** Slim space shape the gates need (id + orgId). Avoids caching Date fields. */
export interface CachedSpace {
  id: number;
  orgId: number;
  uuid: string;
}

/**
 * Read-through: KV hit → return; miss → load, write back (non-blocking via
 * waitUntil), return. Null/undefined loads are NOT cached. Fails open.
 */
async function readThrough<T>(
  c: Context<HonoEnv>,
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T | null>,
): Promise<T | null> {
  const cache = getCacheStore(c.env);
  const logger = createLogger({
    service: 'api',
    environment: c.env.ENVIRONMENT,
  });
  try {
    const hit = await cache.getJson<T>(key);
    if (hit !== null) return hit;
  } catch (err) {
    logger.warn('gate_cache.read_failed', { stage: 'gate_cache_read' }, err);
  }

  const fresh = await loader();
  if (fresh != null) {
    getBackgroundTasks(c).waitUntil(
      cache
        .putJson(key, fresh, { expirationTtlSeconds: ttlSeconds })
        .catch((err) =>
          logger.warn('gate_cache.write_failed', { stage: 'gate_cache_write' }, err),
        ),
    );
  }
  return fresh;
}

/** Org entitlements (plan limits + feature flags). Never null (defaults/throws). */
export async function getCachedEntitlements(
  c: Context<HonoEnv>,
  orgId: number,
): Promise<Entitlements> {
  const db = getDb(c);
  const ent = await readThrough<Entitlements>(c, entKey(orgId), ENTITLEMENTS_TTL_SECONDS, () =>
    getEntitlements(db, orgId),
  );
  // getEntitlements resolves defaults or throws — it never yields null.
  return ent as Entitlements;
}

/** Org membership row, or null if the user isn't a member (null not cached). */
export async function getCachedMembership(
  c: Context<HonoEnv>,
  orgId: number,
  userId: number,
): Promise<MembershipRow | null> {
  const db = getDb(c);
  return readThrough<MembershipRow>(c, memberKey(orgId, userId), MEMBERSHIP_TTL_SECONDS, () =>
    getMembership(db, orgId, userId),
  );
}

/** Space resolved by uuid (slim), or null if missing (null not cached). */
export async function getCachedSpaceByUuid(
  c: Context<HonoEnv>,
  uuid: string,
): Promise<CachedSpace | null> {
  const db = getDb(c);
  return readThrough<CachedSpace>(c, spaceKey(uuid), SPACE_TTL_SECONDS, async () => {
    const s = await getSpaceByUuid(db, uuid);
    return s ? { id: s.id, orgId: s.orgId, uuid: s.uuid } : null;
  });
}

export async function invalidateEntitlements(env: Env, orgId: number): Promise<void> {
  await getCacheStore(env).delete(entKey(orgId));
}

export async function invalidateMembership(
  env: Env,
  orgId: number,
  userId: number,
): Promise<void> {
  await getCacheStore(env).delete(memberKey(orgId, userId));
}

export async function invalidateSpace(env: Env, uuid: string): Promise<void> {
  await getCacheStore(env).delete(spaceKey(uuid));
}
