/**
 * `daily_usage` upsert — recorded once per job at the terminal transition.
 * Mirrors Python's `record_ingestion_tokens` and the producer-side copy in
 * `apps/api/src/features/usage/service.ts`.
 */
import {
  recordIngestionUsage as recordUsage,
  type Database,
} from '@crosmos/db';
import type { Logger, StageRecorder } from '@crosmos/observability';
import type { TenantScope } from '@crosmos/types';

export async function recordIngestionUsage(
  db: Database,
  scope: TenantScope,
  input: Parameters<typeof recordUsage>[2],
): Promise<void> {
  await recordUsage(db, scope, input);
}

export async function recordIngestionUsageBestEffort(options: {
  db: Database;
  scope: TenantScope;
  input: Parameters<typeof recordUsage>[2];
  stages: StageRecorder;
  logger: Logger;
}): Promise<void> {
  try {
    await options.stages.time(
      'ingestion_usage_rollup',
      { dependency: 'database' },
      () => recordUsage(options.db, options.scope, options.input),
    );
  } catch (error) {
    options.logger.warn('ingestion.record_tokens_failed', {}, error);
  }
}
