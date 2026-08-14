import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index';
export { sql } from 'drizzle-orm';

export * from './schema/index';
export * from './usage-rollup';
export { schema };

export type Database = ReturnType<typeof createDb>;

export interface CreateDbOptions {
  /**
   * Max connections in this isolate's pool. Keep this TINY.
   *
   * On Cloudflare Workers each request/queue-message runs in its own isolate
   * and gets its own pool (see the I/O-isolation note below). The effective
   * connection count against Postgres is therefore `max × concurrent isolates`,
   * not `max`. In prod, Hyperdrive pools server-side, so the client only needs
   * enough connections to cover the in-flight queries of a single
   * request/pipeline (we run a few in parallel). Locally (`wrangler dev`
   * connects straight to Postgres, bypassing Hyperdrive) a large `max`
   * multiplied across isolates is exactly what exhausts `max_connections` and
   * yields `sorry, too many clients already`.
   */
  max?: number;
}

/**
 * Create a postgres-js-backed Drizzle client.
 *
 * IMPORTANT — Cloudflare I/O isolation: the returned client owns a DB socket,
 * which is an I/O object bound to the isolate/request that created it. Workers
 * forbid using an I/O object created in one request inside another request's
 * handler (`Cannot perform I/O on behalf of a different request`). So this MUST
 * be created per-request (api) or per-message (ingestion) — never hoisted to a
 * module-level singleton. See `apps/api/src/db.ts` and
 * `apps/ingestion/src/db.ts` for the per-request/per-message wiring.
 */
export function createDb(connectionString: string, options: CreateDbOptions = {}) {
  const sql = postgres(connectionString, {
    // Tiny by default — see CreateDbOptions.max. Two lets a request/pipeline
    // run a couple of queries concurrently without hoarding pool slots.
    max: options.max ?? 2,
    // Close idle connections quickly so a recycled isolate doesn't pin slots
    // (this is what `idle_timeout: 0` got wrong — connections leaked forever).
    idle_timeout: 4, // seconds
    // Recycle long-lived connections so a single isolate can't hold one open
    // indefinitely (defends against server-side connection-state drift).
    max_lifetime: 60 * 30, // seconds (30 min)
    // Fail fast instead of hanging an isolate on a wedged connect.
    connect_timeout: 10, // seconds
    // We don't use dynamic type parsing; skipping the catalog round-trip saves
    // a query on first use per pool.
    fetch_types: false,
  });
  return drizzle(sql, { schema, casing: 'snake_case' });
}
