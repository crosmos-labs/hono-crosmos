import {
  authorizationCodes,
  billingEvents,
  createDb,
  dailyUsage,
  ingestionJobs,
  revokedRefreshTokens,
  type Database,
} from '@crosmos/db';
import { createLogger } from '@crosmos/observability';
import { and, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import type { Env } from '../../bindings';
import { getApiConfig } from '../../config';

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

/** Terminal ingestion-job statuses safe to prune (see schema/enums.ts). */
const TERMINAL_INGESTION_STATUSES = [
  'completed',
  'partial',
  'failed',
  'cancelled',
] as const;

function cutoffDate(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
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
  const retention = getApiConfig(env).retentionDays;
  const result: CleanupResult = {
    authorizationCodes: 0,
    revokedRefreshTokens: 0,
    ingestionJobs: 0,
    billingEvents: 0,
    dailyUsage: 0,
  };

  /** Run one sweep in isolation: a single failure must never abort the rest. */
  async function sweep(
    table: string,
    fn: () => Promise<number>,
  ): Promise<number> {
    try {
      const deleted = await fn();
      logger.info('maintenance.cleanup_swept', { table, deleted_count: deleted });
      return deleted;
    } catch (err) {
      logger.error(
        'maintenance.cleanup_failed',
        { table },
        err,
      );
      return 0;
    }
  }

  const now = new Date();

  // 1. OAuth authorization codes: short-lived, single-use. Remove anything
  //    already expired or consumed — these are never useful past that point.
  result.authorizationCodes = await sweep('authorization_codes', async () => {
    const rows = await db
      .delete(authorizationCodes)
      .where(
        or(lt(authorizationCodes.expiresAt, now), authorizationCodes.used),
      )
      .returning({ code: authorizationCodes.code });
    return rows.length;
  });

  // 2. Revoked refresh tokens: kept for replay/reuse detection while the
  //    underlying token could still be presented. Once well past expiry (and
  //    past the retention window from revocation) they can never be replayed,
  //    so they are safe to drop. Default 30-day window.
  result.revokedRefreshTokens = await sweep('revoked_refresh_tokens', async () => {
    const cutoff = cutoffDate(retention.revokedTokens);
    const rows = await db
      .delete(revokedRefreshTokens)
      .where(
        and(
          lt(revokedRefreshTokens.expiresAt, cutoff),
          lt(revokedRefreshTokens.revokedAt, cutoff),
        ),
      )
      .returning({ jti: revokedRefreshTokens.jti });
    return rows.length;
  });

  // 3. Ingestion jobs: prune terminal jobs older than the retention window.
  //    Active/queued jobs (pending/processing) are always preserved. Default
  //    90 days, overridable via INGESTION_JOB_RETENTION_DAYS.
  result.ingestionJobs = await sweep('ingestion_jobs', async () => {
    const cutoff = cutoffDate(retention.ingestionJobs);
    const rows = await db
      .delete(ingestionJobs)
      .where(
        and(
          inArray(ingestionJobs.status, [...TERMINAL_INGESTION_STATUSES]),
          lt(ingestionJobs.createdAt, cutoff),
        ),
      )
      .returning({ id: ingestionJobs.id });
    return rows.length;
  });

  // 4. Billing events: keep processed Polar events for audit/idempotency, then
  //    prune past the retention window. Unprocessed events (processed_at NULL)
  //    are retained so reconciliation can still pick them up. Default 180 days.
  result.billingEvents = await sweep('billing_events', async () => {
    const cutoff = cutoffDate(retention.billingEvents);
    const rows = await db
      .delete(billingEvents)
      .where(
        and(
          isNotNull(billingEvents.processedAt),
          lt(billingEvents.receivedAt, cutoff),
        ),
      )
      .returning({ id: billingEvents.id });
    return rows.length;
  });

  // 5. Daily usage counters: keep ~13 months for billing history, then prune.
  //    `date` is a calendar date column, so compare against the cutoff date.
  result.dailyUsage = await sweep('daily_usage', async () => {
    const cutoff = cutoffDate(retention.dailyUsage);
    const cutoffYmd = cutoff.toISOString().slice(0, 10);
    const rows = await db
      .delete(dailyUsage)
      .where(lt(dailyUsage.date, sql`${cutoffYmd}::date`))
      .returning({ id: dailyUsage.id });
    return rows.length;
  });

  return result;
}
