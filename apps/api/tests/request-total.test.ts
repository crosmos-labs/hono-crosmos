import { describe, expect, mock, test } from 'bun:test';

mock.module('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(public ctx: unknown, public env: unknown) {}
  },
}));

const { app } = await import('../src/index');

describe('full application request timing', () => {
  test('emits the private response-ready clock and a bounded custom span', async () => {
    const points: Array<{
      indexes?: string[];
      blobs?: Array<string | null>;
      doubles?: number[];
    }> = [];
    const spans: Array<{ name: string; attributes: Record<string, unknown> }> = [];
    const executionCtx = {
      waitUntil(promise: Promise<unknown>) { void promise; },
      passThroughOnException() {},
      props: {},
      tracing: {
        enterSpan<T>(name: string, callback: (span: Span) => T): T {
          const attributes: Record<string, unknown> = {};
          spans.push({ name, attributes });
          return callback({
            isTraced: true,
            setAttribute(key: string, value?: boolean | number | string) {
              attributes[key] = value;
            },
          } as Span);
        },
      },
    } as unknown as ExecutionContext;
    const env = {
      ENVIRONMENT: 'development',
      CF_VERSION_METADATA: { id: '12345678-rest', tag: '', timestamp: '' },
      ANALYTICS: { writeDataPoint(point: (typeof points)[number]) { points.push(point); } },
    } as any;

    const response = await app.request(
      '/.well-known/security.txt',
      undefined,
      env,
      executionCtx,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('server-timing')).toBeNull();
    expect(response.headers.get('x-crosmos-server-ms')).toBeNull();
    expect(response.headers.get('x-crosmos-took-ms')).toBeNull();

    const total = points.find((point) => point.indexes?.[0] === 'request_total');
    expect(total?.blobs).toEqual([
      'api',
      'development',
      'request_total',
      '12345678',
      'GET',
      '/.well-known/security.txt',
      '200',
      'ok',
    ]);
    expect(total?.doubles?.[0]).toBeGreaterThanOrEqual(0);
    expect(spans).toEqual([{
      name: 'api.request_total',
      attributes: {
        'http.request.method': 'GET',
        'url.path': '/.well-known/security.txt',
        'http.response.status_code': 200,
        'crosmos.outcome': 'ok',
      },
    }]);

    const missing = await app.request('/does-not-exist', undefined, env, executionCtx);
    expect(missing.status).toBe(404);
    const failedTotal = points
      .filter((point) => point.indexes?.[0] === 'request_total')
      .at(-1);
    expect(failedTotal?.blobs?.slice(4)).toEqual([
      'GET',
      '/does-not-exist',
      '404',
      'failed',
    ]);
    expect(spans.at(-1)).toEqual({
      name: 'api.request_total',
      attributes: {
        'http.request.method': 'GET',
        'url.path': '/does-not-exist',
        'http.response.status_code': 404,
        'crosmos.outcome': 'failed',
      },
    });
  });
});
