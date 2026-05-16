import { createDb, type Database } from '@crosmos/db';
import type { Env } from './bindings';

/**
 * Connection factory for the ingestion worker. A queue invocation gets one
 * Database via `getDb(env)` for the lifetime of the message — the underlying
 * `postgres-js` pool stays bound to this isolate.
 *
 * We don't cache across invocations because the V8 isolate may be reused or
 * recycled at any time; the pool would outlive its useful lifetime. The cost
 * of recreating is amortized across a 5–15s pipeline run.
 */
export function getDb(env: Env): Database {
  return createDb(env.HYPERDRIVE.connectionString);
}
