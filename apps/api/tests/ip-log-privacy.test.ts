import { describe, expect, test } from 'bun:test';
import { createLogger } from '@crosmos/observability';
import { hashIpForLog } from '../src/integrations/rate-limit/ip';

describe('rate-limit IP log privacy', () => {
  test('is stable within one salt and changes after rotation', async () => {
    const first = await hashIpForLog('salt-one', '203.0.113.42');
    const repeated = await hashIpForLog('salt-one', '203.0.113.42');
    const rotated = await hashIpForLog('salt-two', '203.0.113.42');

    expect(first).toBe(repeated);
    expect(first).toHaveLength(16);
    expect(rotated).not.toBe(first);
    expect(first).not.toContain('203.0.113.42');
  });

  test('omits the identifier when the secret is unavailable', async () => {
    expect(await hashIpForLog(undefined, '203.0.113.42')).toBeUndefined();
  });

  test('the production allowlist rejects raw ip and admits only ip_hash', () => {
    const calls: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => calls.push(args);
    try {
      createLogger({ service: 'api', environment: 'production' }).warn(
        'ratelimit.ip_exceeded',
        { ip: '203.0.113.42', ip_hash: '0123456789abcdef' },
      );
    } finally {
      console.warn = originalWarn;
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toMatchObject({
      event: 'ratelimit.ip_exceeded',
      ip_hash: '0123456789abcdef',
    });
    expect(calls[0]?.[0]).not.toHaveProperty('ip');
  });
});
