/**
 * P1-F — bounded, classified retries for scheduled sweeps.
 *
 * The point of this helper is the classification, not the retrying. Retrying a
 * dropped connection recovers a sweep that would otherwise have deferred all of
 * its work to the next cron (15 minutes, or a full day for the daily sweeps).
 * Retrying provider capacity exhaustion — which the provider has already said
 * will not clear until a fixed time — or an ordinary logic error only burns
 * budget and hides defects behind apparent flakiness.
 */
import { describe, expect, test } from 'bun:test';
import type { Logger } from '@crosmos/observability';
import {
  runSweep,
  SWEEP_BACKOFF_BASE_MS,
  SWEEP_MAX_ATTEMPTS,
  sweepBackoffMs,
} from '../src/lib/sweep-retry';

interface Recorded {
  level: string;
  event: string;
  fields?: Record<string, unknown>;
}

function fakeLogger(sink: Recorded[]): Logger {
  const record =
    (level: string) =>
    (event: string, fields?: Record<string, unknown>) => {
      sink.push({ level, event, fields });
    };
  const logger: Logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
    time: async (_e, _f, fn) => fn(),
  };
  return logger;
}

/** Matches the transient patterns in `classifyDependencyError`. */
const transient = () => new Error('write CONNECTION_CLOSED hyperdrive.local:5432');
/** Matches the capacity patterns — deterministic until a stated renewal time. */
const capacity = () =>
  new Error('Usage limit for account exceeded, usage renews at 2026-07-26 00:00:00 UTC');
/** Unclassified: an ordinary bug or a constraint violation. */
const deterministicBug = () =>
  new Error('duplicate key value violates unique constraint "uq_chunk_memory"');

function harness() {
  const logs: Recorded[] = [];
  const slept: number[] = [];
  const metricCalls: { name: string; tags?: unknown[]; values?: number[] }[] = [];
  return {
    logs,
    slept,
    metricCalls,
    logger: fakeLogger(logs),
    options: {
      sleep: async (ms: number) => {
        slept.push(ms);
      },
      // Deterministic jitter: always the top of the range.
      random: () => 0.999_999,
      metrics: {
        count: (name: string, fields?: { tags?: unknown[]; values?: number[] }) => {
          metricCalls.push({ name, ...fields });
        },
      },
    },
  };
}

describe('runSweep — transient database errors', () => {
  test('a transient-first / success-second sweep completes once with no duplicate run', async () => {
    const h = harness();
    let runs = 0;

    const result = await runSweep(
      'ingestion_redrive',
      h.logger,
      async () => {
        runs += 1;
        if (runs === 1) throw transient();
        return { jobsCreated: 2 };
      },
      h.options,
    );

    expect(result.status).toBe('succeeded');
    expect(result.value).toEqual({ jobsCreated: 2 });
    expect(result.attempts).toBe(2);
    // The successful body ran exactly once — the retry did not double-apply it.
    expect(runs).toBe(2);
    expect(h.logs.map((l) => l.event)).toContain('cron.sweep_recovered');
  });

  test('a persistently transient sweep exhausts exactly the configured budget', async () => {
    const h = harness();
    let runs = 0;

    const result = await runSweep(
      'jobs_reap',
      h.logger,
      async () => {
        runs += 1;
        throw transient();
      },
      h.options,
    );

    expect(result.status).toBe('failed');
    expect(runs).toBe(SWEEP_MAX_ATTEMPTS);
    expect(result.attempts).toBe(SWEEP_MAX_ATTEMPTS);
    expect(h.slept).toHaveLength(SWEEP_MAX_ATTEMPTS - 1);

    const failure = h.logs.find((l) => l.event === 'cron.sweep_failed');
    expect(failure?.level).toBe('error');
    expect(failure?.fields?.reason).toBe('retry_budget_exhausted');
    expect(failure?.fields?.sweep).toBe('jobs_reap');
    expect(failure?.fields?.attempts).toBe(SWEEP_MAX_ATTEMPTS);
  });
});

describe('runSweep — errors that must not be retried', () => {
  test('capacity exhaustion gets exactly one attempt', async () => {
    const h = harness();
    let runs = 0;

    const result = await runSweep(
      'billing_reconciliation',
      h.logger,
      async () => {
        runs += 1;
        throw capacity();
      },
      h.options,
    );

    expect(runs).toBe(1);
    expect(result.attempts).toBe(1);
    expect(h.slept).toHaveLength(0);
    expect(
      h.logs.find((l) => l.event === 'cron.sweep_failed')?.fields?.reason,
    ).toBe('not_retryable');
  });

  test('an unclassified error gets exactly one attempt', async () => {
    const h = harness();
    let runs = 0;

    await runSweep(
      'maintenance_cleanup',
      h.logger,
      async () => {
        runs += 1;
        throw deterministicBug();
      },
      h.options,
    );

    expect(runs).toBe(1);
    expect(h.slept).toHaveLength(0);
    expect(
      h.logs.find((l) => l.event === 'cron.sweep_failed')?.fields?.reason,
    ).toBe('not_retryable');
  });
});

describe('runSweep — isolation and reporting', () => {
  test('never throws, so one exhausted sweep cannot block the next', async () => {
    const h = harness();

    const first = await runSweep('a', h.logger, async () => {
      throw transient();
    }, h.options);
    const second = await runSweep('b', h.logger, async () => 'ok', h.options);

    expect(first.status).toBe('failed');
    expect(second.status).toBe('succeeded');
    expect(second.value).toBe('ok');
    // Each call carries its own budget.
    expect(second.attempts).toBe(1);
  });

  test('a clean first-attempt success logs no retry noise', async () => {
    const h = harness();
    const result = await runSweep('a', h.logger, async () => 7, h.options);

    expect(result).toMatchObject({ status: 'succeeded', value: 7, attempts: 1 });
    expect(h.logs).toHaveLength(0);
    expect(h.slept).toHaveLength(0);
  });

  test('metrics carry the sweep name, outcome, and attempt count', async () => {
    const h = harness();
    await runSweep('ingestion_redrive', h.logger, async () => 1, h.options);
    await runSweep('jobs_reap', h.logger, async () => {
      throw capacity();
    }, h.options);

    expect(h.metricCalls[0]!.name).toBe('cron_sweep');
    expect(h.metricCalls[0]!.tags).toEqual(['ingestion_redrive', 'succeeded']);
    expect(h.metricCalls[0]!.values?.[0]).toBe(1);
    expect(h.metricCalls[1]!.tags).toEqual([
      'jobs_reap',
      'failed',
      'not_retryable',
    ]);
  });
});

describe('sweepBackoffMs', () => {
  test('is full-jitter exponential and never exceeds its ceiling', () => {
    for (const attempt of [1, 2, 3]) {
      const ceiling = SWEEP_BACKOFF_BASE_MS * 2 ** (attempt - 1);
      expect(sweepBackoffMs(attempt, () => 0)).toBe(0);
      expect(sweepBackoffMs(attempt, () => 0.999_999)).toBeLessThan(ceiling);
      expect(sweepBackoffMs(attempt, () => 0.5)).toBe(Math.floor(ceiling / 2));
    }
  });

  test('the ceiling doubles per attempt', () => {
    const half = (n: number) => sweepBackoffMs(n, () => 0.5);
    expect(half(2)).toBe(half(1) * 2);
    expect(half(3)).toBe(half(2) * 2);
  });
});
