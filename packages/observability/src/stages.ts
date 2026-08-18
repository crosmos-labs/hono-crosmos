import { durationMs } from './time';
import type { TraceProvider, TraceSpan } from './tracing';
import type {
  LogFields,
  Logger,
  Metrics,
  StageMeasurements,
  StageRecorder,
} from './types';

export function createStageRecorder(options: {
  logger?: Logger;
  metrics?: Metrics;
  tracing?: TraceProvider;
  event: string;
  metric: 'api_stage' | 'ingestion_stage';
}): StageRecorder {
  const emit = (
    stage: string,
    outcome: 'ok' | 'failed',
    elapsed: number,
    fields: LogFields = {},
    measurements: StageMeasurements = {},
    err?: unknown,
  ) => {
    const inputCount = measurements.inputCount ?? -1;
    const outputCount = measurements.outputCount ?? -1;
    const transferBytes = measurements.transferBytes ?? -1;
    const logFields: LogFields = {
      ...fields,
      stage,
      status: outcome,
      duration_ms: elapsed,
      input_count: inputCount,
      output_count: outputCount,
      transfer_bytes: transferBytes,
    };
    if (outcome === 'failed') options.logger?.error(options.event, logFields, err);
    else options.logger?.info(options.event, logFields);
    options.metrics?.count(options.metric, {
      tags: [stage, outcome],
      values: [elapsed, inputCount, outputCount, transferBytes],
      index: options.metric,
    });
  };

  return {
    record: emit,
    span(stage, fn) {
      return options.tracing
        ? options.tracing.enterSpan(`${options.metric}.${stage}`, fn)
        : fn();
    },
    time(stage, fields, fn, measurements = {}) {
      const run = async (span?: TraceSpan) => {
        const start = performance.now();
        try {
          const result = await fn();
          const observed = typeof measurements === 'function'
            ? measurements(result)
            : measurements;
          span?.setAttribute('crosmos.stage', stage);
          span?.setAttribute('crosmos.outcome', 'ok');
          if (observed.inputCount !== undefined) {
            span?.setAttribute('crosmos.input_count', observed.inputCount);
          }
          if (observed.outputCount !== undefined) {
            span?.setAttribute('crosmos.output_count', observed.outputCount);
          }
          if (observed.transferBytes !== undefined) {
            span?.setAttribute('crosmos.transfer_bytes', observed.transferBytes);
          }
          emit(stage, 'ok', durationMs(start), fields, observed);
          return result;
        } catch (err) {
          span?.setAttribute('crosmos.stage', stage);
          span?.setAttribute('crosmos.outcome', 'failed');
          emit(
            stage,
            'failed',
            durationMs(start),
            fields,
            typeof measurements === 'function' ? {} : measurements,
            err,
          );
          throw err;
        }
      };
      return options.tracing
        ? options.tracing.enterSpan(`${options.metric}.${stage}`, run)
        : run();
    },
  };
}
