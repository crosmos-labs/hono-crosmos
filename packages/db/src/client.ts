import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index';

export { schema };
export type Database = ReturnType<typeof createDb>;

export interface CreateDbOptions {
  /** Maximum connections owned by one Worker isolate. */
  max?: number;
}

/** Create a request-scoped postgres-js/Drizzle client. Never hoist it globally. */
export function createDb(connectionString: string, options: CreateDbOptions = {}) {
  const sql = postgres(connectionString, {
    max: options.max ?? 2,
    idle_timeout: 4,
    max_lifetime: 60 * 30,
    connect_timeout: 10,
    fetch_types: false,
  });
  return drizzle(sql, { schema, casing: 'snake_case' });
}
