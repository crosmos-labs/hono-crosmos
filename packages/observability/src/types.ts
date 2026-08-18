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
  time<T>(event: string, fields: LogFields, fn: () => Promise<T>): Promise<T>;
}

export interface LoggerOptions {
  service: string;
  environment?: string;
  base?: LogFields;
}

export interface AnalyticsDataset {
  writeDataPoint(event: {
    indexes?: string[];
    blobs?: (string | null)[];
    doubles?: number[];
  }): void;
}

export interface WorkerVersionMetadata {
  id: string;
  tag: string;
  timestamp: string;
}

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

export interface StageMeasurements {
  inputCount?: number;
  outputCount?: number;
  transferBytes?: number;
}

export interface StageRecorder {
  record(
    stage: string,
    outcome: 'ok' | 'failed',
    durationMs: number,
    fields?: LogFields,
    measurements?: StageMeasurements,
    err?: unknown,
  ): void;
  span<T>(stage: string, fn: () => T): T;
  time<T>(
    stage: string,
    fields: LogFields,
    fn: () => Promise<T>,
    measurements?: StageMeasurements | ((result: T) => StageMeasurements),
  ): Promise<T>;
}
