import { createDb, type Database } from '@crosmos/db';
import type { Context } from 'hono';
import type { HonoEnv } from './bindings.js';

const DB_KEY = Symbol.for('crosmos.db');

interface DbHolder {
  [DB_KEY]?: Database;
}

/**
 * Get the per-request Database, cached on the request's ExecutionContext.
 *
 * DO NOT hoist this to a module-level singleton. The Database owns a DB socket,
 * which is an I/O object that Cloudflare binds to the request that created it;
 * reusing it across requests throws `Cannot perform I/O on behalf of a
 * different request`. Caching on `executionCtx` keeps exactly one pool per
 * request. See `createDb` in `@crosmos/db` for the pool-sizing rationale.
 */
export function getDb(c: Context<HonoEnv>): Database {
  const exec = c.executionCtx as unknown as DbHolder | undefined;
  if (exec && exec[DB_KEY]) {
    return exec[DB_KEY]!;
  }
  const db = createDb(c.env.HYPERDRIVE.connectionString);
  if (exec) exec[DB_KEY] = db;
  return db;
}
