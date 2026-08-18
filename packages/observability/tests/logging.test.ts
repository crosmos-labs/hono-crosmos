import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createLogger, errorFields } from '../src';

afterEach(() => mock.restore());

describe('structured logging', () => {
  test('keeps allowlisted fields and normalizes nested values', () => {
    const output = spyOn(console, 'log').mockImplementation(() => {});
    createLogger({ service: 'api', environment: 'development' }).info('test.event', {
      source_ids: [1, 2],
      sample: { recorded_at: new Date('2026-08-19T00:00:00.000Z') },
    });
    expect(output).toHaveBeenCalledTimes(1);
    expect(output.mock.calls[0]?.[0]).toMatchObject({
      event: 'test.event',
      service: 'api',
      source_ids: [1, 2],
      sample: { recorded_at: '2026-08-19T00:00:00.000Z' },
    });
  });

  test('drops an unknown field and warns once outside production', () => {
    const output = spyOn(console, 'log').mockImplementation(() => {});
    const warnings = spyOn(console, 'warn').mockImplementation(() => {});
    const logger = createLogger({ service: 'api', environment: 'development' });
    logger.info('test.event', { unsafe_test_value: 'secret' });
    logger.info('test.event', { unsafe_test_value: 'secret' });
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(output.mock.calls[0]?.[0]).not.toHaveProperty('unsafe_test_value');
  });

  test('drops an unknown field silently in production', () => {
    const output = spyOn(console, 'log').mockImplementation(() => {});
    const warnings = spyOn(console, 'warn').mockImplementation(() => {});
    createLogger({ service: 'api', environment: 'production' }).info('test.event', {
      another_unsafe_test_value: 'secret',
    });
    expect(warnings).not.toHaveBeenCalled();
    expect(output.mock.calls[0]?.[0]).not.toHaveProperty('another_unsafe_test_value');
  });

  test('serializes safe error attributes', () => {
    const error = Object.assign(new Error('provider failed'), {
      status: 503,
      retryable: true,
    });
    expect(errorFields(error)).toEqual({
      error_name: 'Error',
      error_message: 'provider failed',
      status_code: 503,
      retryable: true,
    });
    expect(errorFields('failed')).toEqual({
      error_name: 'string',
      error_message: 'failed',
    });
  });
});
