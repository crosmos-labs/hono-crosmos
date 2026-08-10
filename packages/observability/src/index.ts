export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Date
  | LogValue[]
  | { readonly [key: string]: LogValue };

export type LogFields = Record<string, LogValue>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields, err?: unknown): void;
  error(event: string, fields?: LogFields, err?: unknown): void;
  child(fields: LogFields): Logger;
  time<T>(
    event: string,
    fields: LogFields,
    fn: () => Promise<T>,
  ): Promise<T>;
}

export interface LoggerOptions {
  service: string;
  environment?: string;
  base?: LogFields;
}

/**
 * Structured-log field allowlist — a PII guard. Anything not listed here is
 * stripped before emission, so user content can never leak into logs by way of
 * a careless field name.
 *
 * It only works if it stays in sync with the call sites: a field that drifts off
 * this list disappears silently in production, which is its own observability
 * failure (the non-prod one-shot warning below exists precisely because that
 * happened). Everything here is an identifier, a count, a duration, or a
 * bounded enum — never a fact, query, name, or other user-supplied string.
 *
 * When adding a log field, add it here in the same change.
 */
const FIELD_ALLOWLIST = new Set([
  'access_frequency',
  'attempt',
  'attempts',
  'auth_method',
  'cancelled_count',
  'candidate_count',
  'candidates',
  'cap_hit',
  'ce_enabled',
  'checkouts_abandoned',
  'chunk_count',
  'chunks_processed',
  'client_id',
  'code',
  'completed_source_count',
  'continuation_count',
  'correlation_id',
  'count',
  'cron',
  'degraded_count',
  'degraded_job_count',
  'degraded_job_ids',
  'degraded_signals',
  'delay_seconds',
  'deleted_count',
  'dependency',
  'deterministic',
  'duration_ms',
  'edge_count',
  'embedding_count',
  'embedding_mode',
  'entity_count',
  'environment',
  'error_category',
  'error_code',
  'error_message',
  'error_name',
  'event',
  'existing_memory_count',
  'fail_closed',
  'failed_job_count',
  'failed_job_ids',
  'failed_source_count',
  'final_status',
  'floor',
  'from_sequence',
  'graph_enabled',
  'input_token_count',
  'ip',
  'job_count',
  'job_id',
  'jobs_created',
  'jobs_reaped',
  'level',
  'limit',
  'marked_exhausted',
  'marked_owner_deleted',
  'max_attempts',
  'memory_count',
  'method',
  'model',
  'org_id',
  'path',
  'permanent_failed_count',
  'processed_chunk_count',
  'provider',
  'query_length',
  'queue_delay_ms',
  'reason',
  'recall_id',
  'remaining_chunk_count',
  'remaining_source_count',
  'request_id',
  'result_count',
  'retry_after_seconds',
  'retryable',
  'sample',
  'scope',
  'service',
  'signal',
  'skipped_no_owner',
  'source_count',
  'source_id',
  'source_ids',
  'sources_requeued',
  'space_id',
  'stage',
  'status',
  'status_code',
  'subscriptions_expired',
  'table',
  'threshold',
  'timed_out',
  'timestamp',
  'to_sequence',
  'token_count',
  'top_k',
  'total_job_count',
  'total_ms',
  'transient_source_count',
  'trigger',
  'user_id',
  'vector_count',
]);

/**
 * Tracks keys we've already warned about being dropped (dev only) so the
 * one-shot warning doesn't spam. The allowlist is a PII guard — but a key that
 * silently vanishes from logs is its own observability failure, so outside
 * production we surface the drift once per key per isolate.
 */
const warnedDroppedFields = new Set<string>();

export function createLogger(options: LoggerOptions): Logger {
  return new ConsoleLogger({
    service: options.service,
    environment: options.environment ?? 'development',
    ...(options.base ?? {}),
  });
}

export function errorFields(err: unknown): LogFields {
  if (err instanceof Error) {
    const fields: LogFields = {
      error_name: err.name,
      error_message: err.message,
    };
    const maybeStatus = (err as { status?: unknown }).status;
    if (typeof maybeStatus === 'number') fields.status_code = maybeStatus;
    const maybeRetryable = (err as { retryable?: unknown }).retryable;
    if (typeof maybeRetryable === 'boolean') fields.retryable = maybeRetryable;
    return fields;
  }
  return {
    error_name: typeof err,
    error_message: String(err),
  };
}

export function durationMs(start: number): number {
  return Math.max(0, Math.round((performance.now() - start) * 100) / 100);
}

/**
 * Structural shape of a Cloudflare Analytics Engine binding. Declared locally
 * so this package doesn't depend on `@cloudflare/workers-types`. Bound as
 * `ANALYTICS` in each worker's wrangler config.
 */
export interface AnalyticsDataset {
  writeDataPoint(event: {
    indexes?: string[];
    blobs?: (string | null)[];
    doubles?: number[];
  }): void;
}

/**
 * A metric sink. `count` emits one data point per named metric. Dimensions
 * (`tags`) become blobs, measurements (`values`) become doubles, and `index`
 * is the Analytics Engine sampling key (keep it low-cardinality, e.g. the
 * metric name or org id). Emission NEVER throws — metrics must not break a
 * request. When no dataset is bound (local dev / tests) it is a silent no-op.
 *
 * Analytics Engine positional limits: ≤20 blobs, ≤20 doubles, one index ≤96B.
 * Convention: blob[0]=service, blob[1]=environment, blob[2]=metric name, then
 * the caller's `tags`. So document the tag/value order at each call site.
 */
export interface Metrics {
  count(
    name: string,
    fields?: {
      tags?: Array<string | number | boolean | null | undefined>;
      values?: number[];
      index?: string;
    },
  ): void;
}

const NOOP_METRICS: Metrics = { count() {} };

export function createMetrics(
  dataset: AnalyticsDataset | undefined,
  base?: { service?: string; environment?: string },
): Metrics {
  if (!dataset) return NOOP_METRICS;
  const service = base?.service ?? 'unknown';
  const environment = base?.environment ?? 'development';
  return {
    count(name, fields = {}) {
      try {
        const tagBlobs = (fields.tags ?? []).map((t) =>
          t == null ? null : String(t),
        );
        dataset.writeDataPoint({
          indexes: [fields.index ?? name],
          blobs: [service, environment, name, ...tagBlobs].slice(0, 20),
          doubles: (fields.values ?? []).slice(0, 20),
        });
      } catch {
        // Metrics are best-effort; a binding hiccup must never surface.
      }
    },
  };
}

class ConsoleLogger implements Logger {
  constructor(private readonly base: LogFields) {}

  debug(event: string, fields: LogFields = {}): void {
    this.emit('debug', event, fields);
  }

  info(event: string, fields: LogFields = {}): void {
    this.emit('info', event, fields);
  }

  warn(event: string, fields: LogFields = {}, err?: unknown): void {
    this.emit('warn', event, {
      ...fields,
      ...(err === undefined ? {} : errorFields(err)),
    });
  }

  error(event: string, fields: LogFields = {}, err?: unknown): void {
    this.emit('error', event, {
      ...fields,
      ...(err === undefined ? {} : errorFields(err)),
    });
  }

  child(fields: LogFields): Logger {
    return new ConsoleLogger({ ...this.base, ...fields });
  }

  async time<T>(
    event: string,
    fields: LogFields,
    fn: () => Promise<T>,
  ): Promise<T> {
    const start = performance.now();
    try {
      const value = await fn();
      this.info(event, { ...fields, duration_ms: durationMs(start), status: 'ok' });
      return value;
    } catch (err) {
      this.error(
        event,
        { ...fields, duration_ms: durationMs(start), status: 'error' },
        err,
      );
      throw err;
    }
  }

  private emit(level: LogLevel, event: string, fields: LogFields): void {
    const record = sanitizeRecord({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...this.base,
      ...fields,
    });

    if (level === 'error') {
      console.error(record);
    } else if (level === 'warn') {
      console.warn(record);
    } else {
      console.log(record);
    }
  }
}

function sanitizeRecord(fields: LogFields): LogFields {
  const out: LogFields = {};
  const environment = fields.environment;
  for (const [key, value] of Object.entries(fields)) {
    if (!FIELD_ALLOWLIST.has(key)) {
      // Non-prod: warn once per key so allowlist drift is visible instead of a
      // field silently disappearing. Skip the meta keys that are intentionally
      // not in the allowlist when present on their own.
      if (
        environment !== 'production' &&
        value !== undefined &&
        !warnedDroppedFields.has(key)
      ) {
        warnedDroppedFields.add(key);
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'observability.field_dropped',
            dropped_field: key,
          }),
        );
      }
      continue;
    }
    const normalized = normalizeValue(value);
    if (normalized !== undefined) out[key] = normalized;
  }
  return out;
}

function normalizeValue(value: LogValue): LogValue {
  if (value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeValue).filter((v) => v !== undefined);
  if (value !== null && typeof value === 'object') {
    const out: LogFields = {};
    for (const [key, child] of Object.entries(value)) {
      const normalized = normalizeValue(child);
      if (normalized !== undefined) out[key] = normalized;
    }
    return out;
  }
  return value;
}
