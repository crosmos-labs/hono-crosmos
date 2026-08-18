import type { LogFields } from './types';

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
