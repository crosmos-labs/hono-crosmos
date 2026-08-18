import { createDb } from '@crosmos/db';
import type { Context } from 'hono';
import type { AdminEnv } from './bindings';

export function requestDb(c: Context<AdminEnv>) {
  return createDb(c.env.HYPERDRIVE.connectionString);
}

export function positiveInt(value: string | undefined, fallback: number, max: number) {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

export function nonNegativeInt(value: string | undefined, fallback = 0) {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
