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

const FIELD_ALLOWLIST = new Set([
  'access_frequency',
  'attempt',
  'candidate_count',
  'ce_enabled',
  'completed_source_count',
  'correlation_id',
  'duration_ms',
  'edge_count',
  'embedding_count',
  'embedding_mode',
  'entity_count',
  'environment',
  'error_message',
  'error_name',
  'event',
  'failed_source_count',
  'final_status',
  'graph_enabled',
  'job_id',
  'level',
  'limit',
  'memory_count',
  'model',
  'org_id',
  'provider',
  'query_length',
  'queue_delay_ms',
  'request_id',
  'result_count',
  'retryable',
  'service',
  'signal',
  'source_count',
  'source_id',
  'space_id',
  'stage',
  'status',
  'status_code',
  'timed_out',
  'timestamp',
  'token_count',
  'top_k',
  'total_ms',
  'user_id',
]);

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
  for (const [key, value] of Object.entries(fields)) {
    if (!FIELD_ALLOWLIST.has(key)) continue;
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
