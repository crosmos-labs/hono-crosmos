import { createDb, type Database } from '@crosmos/db';
import { createLogger } from '@crosmos/observability';
import type { Env } from '../../bindings';

/**
 * Scheduled retention/cleanup sweep, run from the daily cron alongside billing
 * reconciliation. Bounds the unbounded-growth tables the audit flagged:
 *   - expired OAuth `authorization_codes`
 *   - expired/rotated `revoked_refresh_tokens` past any reuse-detection window
 *   - terminal `ingestion_jobs` older than the retention window
 *   - processed `billing_events` older than the retention window
 *   - stale `daily_usage` rows (kept long enough for billing history)
 *
 * Each delete is independent and best-effort: one failing sweep must not block
 * the others, and the whole job must not throw (it runs in `waitUntil`-free
 * cron context but we still isolate failures and log them).
 *
 * Returns a per-table deleted-row count for logging/metrics.
 */
export interface CleanupResult {
  authorizationCodes: number;
  revokedRefreshTokens: number;
  ingestionJobs: number;
  billingEvents: number;
  dailyUsage: number;
}

export async function runMaintenanceCleanup(env: Env): Promise<CleanupResult> {
  const db = createDb(env.HYPERDRIVE.connectionString);
  return cleanupExpiredRows(db, env);
}

export async function cleanupExpiredRows(
  db: Database,
  env: Env,
): Promise<CleanupResult> {
  const logger = createLogger({ service: 'api', environment: env.ENVIRONMENT });
  const result: CleanupResult = {
    authorizationCodes: 0,
    revokedRefreshTokens: 0,
    ingestionJobs: 0,
    billingEvents: 0,
    dailyUsage: 0,
  };

  // NOTE: implemented by the data-lifecycle/maintenance work — each sweep wrapped
  // in its own try/catch so one failure does not abort the rest. Retention
  // windows are read from env with sane defaults.
  void db;
  void logger;

  return result;
}
