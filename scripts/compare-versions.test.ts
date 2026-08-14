import { afterEach, describe, expect, test } from 'bun:test';
import { parseArgs, percentDelta } from './compare-versions';

const oldAccount = Bun.env.CLOUDFLARE_ACCOUNT_ID;
const oldToken = Bun.env.CLOUDFLARE_API_TOKEN;

afterEach(() => {
  Bun.env.CLOUDFLARE_ACCOUNT_ID = oldAccount;
  Bun.env.CLOUDFLARE_API_TOKEN = oldToken;
});

describe('compare-versions', () => {
  test('parses a deploy-version comparison', () => {
    Bun.env.CLOUDFLARE_ACCOUNT_ID = 'account';
    Bun.env.CLOUDFLARE_API_TOKEN = 'token';
    const options = parseArgs([
      '--before-version', 'abcdef12',
      '--after-version', '3456789a',
      '--min-samples', '250',
    ]);
    expect(options).not.toBe('help');
    if (options === 'help') return;
    expect(options.before.where).toBe("blob4 = 'abcdef12'");
    expect(options.after.where).toBe("blob4 = '3456789a'");
    expect(options.minSamples).toBe(250);
  });

  test('refuses a partial or mixed cohort', () => {
    Bun.env.CLOUDFLARE_ACCOUNT_ID = 'account';
    Bun.env.CLOUDFLARE_API_TOKEN = 'token';
    expect(() => parseArgs(['--before-version', 'abcdef12'])).toThrow();
    expect(() => parseArgs([
      '--before-version', 'abcdef12',
      '--after', '2026-08-01T00:00:00Z,2026-08-02T00:00:00Z',
    ])).toThrow();
  });

  test('formats improvement and zero baselines honestly', () => {
    expect(percentDelta(100, 80)).toBe('-20.0%');
    expect(percentDelta(0, 4)).toBe('n/a');
  });
});
