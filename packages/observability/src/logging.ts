import { errorFields } from './errors';
import { durationMs } from './time';
import type {
  LogFields,
  Logger,
  LoggerOptions,
  LogLevel,
  LogValue,
} from './types';

// PII guard: only bounded identifiers, counts, durations, and enums may pass.
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
  'grants_expired',
  'input_token_count',
  'input_count',
  'ip_hash',
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
  'output_count',
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
  'sequence',
  'service',
  'signal',
  'skipped_no_owner',
  'source_count',
  'source_id',
  'source_ids',
  'sweep',
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
  'transfer_bytes',
  'transient_source_count',
  'trigger',
  'user_id',
  'vector_count',
]);

const warnedDroppedFields = new Set<string>();

export function createLogger(options: LoggerOptions): Logger {
  return new ConsoleLogger({
    service: options.service,
    environment: options.environment ?? 'development',
    ...(options.base ?? {}),
  });
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
    if (level === 'error') console.error(record);
    else if (level === 'warn') console.warn(record);
    else console.log(record);
  }
}

function sanitizeRecord(fields: LogFields): LogFields {
  const out: LogFields = {};
  const environment = fields.environment;
  for (const [key, value] of Object.entries(fields)) {
    if (!FIELD_ALLOWLIST.has(key)) {
      if (
        environment !== 'production'
        && value !== undefined
        && !warnedDroppedFields.has(key)
      ) {
        warnedDroppedFields.add(key);
        console.warn(JSON.stringify({
          level: 'warn',
          event: 'observability.field_dropped',
          dropped_field: key,
        }));
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
  if (Array.isArray(value)) {
    return value.map(normalizeValue).filter((child) => child !== undefined);
  }
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
