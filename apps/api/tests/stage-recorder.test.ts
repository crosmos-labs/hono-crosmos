import { describe, expect, test } from 'bun:test';
import {
  createStageRecorder,
  type AnalyticsDataset,
  type LogFields,
  type Logger,
} from '@crosmos/observability';

function captureLogger(records: Array<{ level: string; event: string; fields: LogFields }>): Logger {
  return {
    debug(event, fields = {}) { records.push({ level: 'debug', event, fields }); },
    info(event, fields = {}) { records.push({ level: 'info', event, fields }); },
    warn(event, fields = {}) { records.push({ level: 'warn', event, fields }); },
    error(event, fields = {}) { records.push({ level: 'error', event, fields }); },
    child() { return this; },
    async time(_event, _fields, fn) { return fn(); },
  };
}

describe('stage recorder', () => {
  test('emits a fixed metric layout and preserves observed zeroes', async () => {
    const points: Parameters<AnalyticsDataset['writeDataPoint']>[0][] = [];
    const records: Array<{ level: string; event: string; fields: LogFields }> = [];
    const recorder = createStageRecorder({
      logger: captureLogger(records),
      metrics: { count(name, fields) { points.push({ blobs: [name, ...(fields?.tags ?? []).map(String)], doubles: fields?.values }); } },
      event: 'retrieval.stage_completed',
      metric: 'api_stage',
    });

    const result = await recorder.time(
      'candidate_lookup',
      {},
      async () => [] as string[],
      (rows) => ({ inputCount: 3, outputCount: rows.length }),
    );

    expect(result).toEqual([]);
    expect(points[0]?.blobs).toEqual(['api_stage', 'candidate_lookup', 'ok']);
    expect(points[0]?.doubles?.slice(1)).toEqual([3, 0, -1]);
    expect(records[0]?.fields.status).toBe('ok');
  });

  test('emits failed before rethrowing and uses -1 for unavailable values', async () => {
    const points: Parameters<AnalyticsDataset['writeDataPoint']>[0][] = [];
    const records: Array<{ level: string; event: string; fields: LogFields }> = [];
    const recorder = createStageRecorder({
      logger: captureLogger(records),
      metrics: { count(_name, fields) { points.push({ blobs: fields?.tags?.map(String), doubles: fields?.values }); } },
      event: 'ingestion.stage_completed',
      metric: 'ingestion_stage',
    });

    await expect(recorder.time('memory_extraction', {}, async () => {
      throw new Error('provider unavailable');
    }, { inputCount: 2 })).rejects.toThrow('provider unavailable');

    expect(points[0]?.blobs).toEqual(['memory_extraction', 'failed']);
    expect(points[0]?.doubles?.slice(1)).toEqual([2, -1, -1]);
    expect(records[0]?.level).toBe('error');
  });

  test('wraps timed work in a bounded custom span with numeric shape only', async () => {
    const spans: Array<{ name: string; attributes: Record<string, unknown> }> = [];
    const recorder = createStageRecorder({
      event: 'retrieval.stage_completed',
      metric: 'api_stage',
      tracing: {
        enterSpan<T>(name: string, callback: (span: { setAttribute(key: string, value?: boolean | number | string): void }) => T): T {
          const attributes: Record<string, unknown> = {};
          spans.push({ name, attributes });
          return callback({ setAttribute(key, value) { attributes[key] = value; } });
        },
      },
    });

    await expect(recorder.time(
      'candidate_lookup',
      { space_id: 999 },
      async () => ['one', 'two'],
      (rows) => ({ inputCount: 5, outputCount: rows.length }),
    )).resolves.toEqual(['one', 'two']);

    expect(spans).toEqual([{
      name: 'api_stage.candidate_lookup',
      attributes: {
        'crosmos.stage': 'candidate_lookup',
        'crosmos.outcome': 'ok',
        'crosmos.input_count': 5,
        'crosmos.output_count': 2,
      },
    }]);
  });
});
