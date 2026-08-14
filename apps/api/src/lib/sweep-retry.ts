/**
 * Bounded, classified retries for scheduled (cron) sweeps.
 *
 * The reaper, ingestion re-drive, billing reconciliation and maintenance
 * cleanup are each isolated and idempotent, but a single dropped connection at
 * the wrong moment deferred all of that sweep's work to the next cron — up to
 * 15 minutes for the re-drive and a full day for the daily sweeps. That is a
 * long time for a wedged source to stay wedged because one TCP connection died.
 *
 * The retry is deliberately narrow. It reuses `classifyDependencyError`, which
 * already separates the two conditions that want opposite behavior:
 *
 *   - transient (`deterministic: false`) — a dropped/reset connection. Retrying
 *     shortly is exactly right.
 *   - capacity exhaustion (`deterministic: true`) — the provider has stated it
 *     will refuse until a known renewal time. Retrying provably cannot succeed
 *     and only burns the sweep's remaining budget, so it gets ONE attempt.
 *
 * Everything else — constraint violations, invalid input, ordinary logic
 * errors — is unclassified and also gets one attempt, so a genuine defect is
 * never disguised as flakiness by being silently retried.
 */
import { createMetrics, durationMs, type Logger, type Metrics } from '@crosmos/observability';
import { classifyDependencyError } from './dependency-errors';

/** Total attempts, including the first. Three keeps the worst case bounded. */
export const SWEEP_MAX_ATTEMPTS = 3;
/** First backoff step; doubles per attempt before jitter. */
export const SWEEP_BACKOFF_BASE_MS = 250;

export interface SweepResult<T> {
  status: 'succeeded' | 'failed';
  /** Present only when `status === 'succeeded'`. */
  value?: T;
  /** Attempts actually made, including the first. */
  attempts: number;
  /** Present only when `status === 'failed'`. */
  error?: unknown;
}

export interface RunSweepOptions {
  /** Overrides for tests; production uses real timers and `Math.random`. */
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  metrics?: Metrics;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Full-jitter exponential backoff: a uniform draw from `[0, base * 2^n)`.
 * Jitter matters even for a single-instance cron, because all four sweeps can
 * be recovering from the same dependency blip at the same moment and lockstep
 * retries would hit it in a thundering herd.
 */
export function sweepBackoffMs(attempt: number, random: () => number): number {
  const ceiling = SWEEP_BACKOFF_BASE_MS * 2 ** (attempt - 1);
  return Math.floor(random() * ceiling);
}

/** True when the error is a classified TRANSIENT dependency failure. */
function isRetryableSweepError(err: unknown): boolean {
  const failure = classifyDependencyError(err);
  return failure !== null && !failure.deterministic;
}

/**
 * Run one scheduled sweep with bounded, classified retries, logging the
 * outcome. Never throws: a sweep that exhausts its budget resolves with
 * `status: 'failed'` so the caller can continue to the next sweep. Each call
 * carries its own independent budget, so one exhausted sweep cannot consume
 * another's.
 */
export async function runSweep<T>(
  name: string,
  logger: Logger,
  run: () => Promise<T>,
  options: RunSweepOptions = {},
): Promise<SweepResult<T>> {
  const maxAttempts = options.maxAttempts ?? SWEEP_MAX_ATTEMPTS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const started = performance.now();

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const value = await run();
      if (attempt > 1) {
        logger.info('cron.sweep_recovered', {
          sweep: name,
          trigger: 'cron',
          attempts: attempt,
          duration_ms: durationMs(started),
        });
      }
      options.metrics?.count('cron_sweep', {
        tags: [name, 'succeeded'],
        values: [attempt, durationMs(started)],
        index: 'cron_sweep',
      });
      return { status: 'succeeded', value, attempts: attempt };
    } catch (err) {
      lastError = err;
      const retryable = isRetryableSweepError(err);
      if (!retryable || attempt === maxAttempts) {
        logger.error(
          'cron.sweep_failed',
          {
            sweep: name,
            trigger: 'cron',
            attempts: attempt,
            // Distinguishes "we gave up after retrying" from "this was never
            // worth retrying", which are very different signals when triaging.
            reason: retryable ? 'retry_budget_exhausted' : 'not_retryable',
            duration_ms: durationMs(started),
          },
          err,
        );
        options.metrics?.count('cron_sweep', {
          tags: [name, 'failed', retryable ? 'retry_budget_exhausted' : 'not_retryable'],
          values: [attempt, durationMs(started)],
          index: 'cron_sweep',
        });
        return { status: 'failed', attempts: attempt, error: err };
      }

      const delay = sweepBackoffMs(attempt, random);
      logger.warn(
        'cron.sweep_retry_scheduled',
        {
          sweep: name,
          trigger: 'cron',
          attempt,
          delay_seconds: delay / 1000,
        },
        err,
      );
      await sleep(delay);
    }
  }

  // Unreachable while maxAttempts >= 1; kept so the function is total.
  return { status: 'failed', attempts: maxAttempts, error: lastError };
}

/** Convenience wrapper that builds the metrics sink from the env bindings. */
export function sweepMetrics(
  analytics: AnalyticsEngineDataset | undefined,
  environment: string | undefined,
  version?: string,
): Metrics {
  return createMetrics(analytics, { service: 'api', environment, version });
}
