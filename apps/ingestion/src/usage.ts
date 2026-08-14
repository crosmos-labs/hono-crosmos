/**
 * `daily_usage` upsert — recorded once per job at the terminal transition.
 * Mirrors Python's `record_ingestion_tokens` and the producer-side copy in
 * `apps/api/src/features/usage/service.ts`.
 */
import {
  recordIngestionUsage as recordUsage,
  type Database,
} from '@crosmos/db';
import type { TenantScope } from '@crosmos/types';

export async function recordIngestionUsage(
  db: Database,
  scope: TenantScope,
  input: Parameters<typeof recordUsage>[2],
): Promise<void> {
  await recordUsage(db, scope, input);
}
