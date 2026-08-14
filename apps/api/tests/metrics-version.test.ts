import { describe, expect, test } from 'bun:test';
import { createMetrics, type AnalyticsDataset } from '@crosmos/observability';

describe('metric deploy-version layout', () => {
  test('reserves blob4 for the shortened Worker version', () => {
    const points: Array<Parameters<AnalyticsDataset['writeDataPoint']>[0]> = [];
    const dataset: AnalyticsDataset = {
      writeDataPoint: (point) => points.push(point),
    };

    createMetrics(dataset, {
      service: 'api',
      environment: 'staging',
      version: '12345678-aaaa-bbbb-cccc-1234567890ab',
    }).count('http_request', {
      tags: ['POST', '/api/v1/search', '200'],
      values: [123.45],
    });

    expect(points).toEqual([
      {
        indexes: ['http_request'],
        blobs: [
          'api',
          'staging',
          'http_request',
          '12345678',
          'POST',
          '/api/v1/search',
          '200',
        ],
        doubles: [123.45],
      },
    ]);
  });

  test('keeps tests and local callers usable without metadata', () => {
    const points: Array<Parameters<AnalyticsDataset['writeDataPoint']>[0]> = [];
    createMetrics({ writeDataPoint: (point) => points.push(point) }).count('test');
    expect(points[0]?.blobs?.[3]).toBe('unknown');
  });
});
