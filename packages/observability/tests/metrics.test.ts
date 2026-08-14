import { describe, expect, test } from 'bun:test';

import { createMetrics, type AnalyticsDataset } from '../src';

describe('createMetrics', () => {
  test('is a silent no-op without a dataset binding', () => {
    expect(() => {
      createMetrics(undefined).count('http_request', {
        tags: ['GET', '/health', 200],
        values: [12],
      });
    }).not.toThrow();
  });

  test('keeps deploy version and caller tags in fixed blob positions', () => {
    const points: Parameters<AnalyticsDataset['writeDataPoint']>[0][] = [];
    const metrics = createMetrics(
      { writeDataPoint: (point) => points.push(point) },
      {
        service: 'api',
        environment: 'production',
        version: '6c547aa3-93e0-4b56-8b64-0be2a0bbe1c8',
      },
    );

    metrics.count('request_total', {
      tags: ['POST', '/api/v1/search', 200, 'ok'],
      values: [956],
    });

    expect(points).toEqual([
      {
        indexes: ['request_total'],
        blobs: [
          'api',
          'production',
          'request_total',
          '6c547aa3',
          'POST',
          '/api/v1/search',
          '200',
          'ok',
        ],
        doubles: [956],
      },
    ]);
  });
});
