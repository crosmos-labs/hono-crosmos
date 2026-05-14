import { createDb, type Database } from '@crosmos/db';
import type { Context } from 'hono';
import type { HonoEnv } from './bindings.js';

const DB_KEY = Symbol.for('crosmos.db');

interface DbHolder {
  [DB_KEY]?: Database;
}

export function getDb(c: Context<HonoEnv>): Database {
  // Cache db per request — Workers v8 isolates may reuse; cheap to recreate on first call.
  const exec = c.executionCtx as unknown as DbHolder | undefined;
  if (exec && exec[DB_KEY]) {
    return exec[DB_KEY]!;
  }
  const db = createDb(c.env.HYPERDRIVE.connectionString);
  if (exec) exec[DB_KEY] = db;
  return db;
}
