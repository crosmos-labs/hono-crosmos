import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index';

export * from './schema/index';
export { schema };

export type Database = ReturnType<typeof createDb>;

export function createDb(connectionString: string) {
  const sql = postgres(connectionString, {
    max: 5,
    fetch_types: false,
  });
  return drizzle(sql, { schema, casing: 'snake_case' });
}
