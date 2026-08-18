import { describe, expect, test } from 'bun:test';
import type { Env } from '../src/bindings';
import { getAdminConfig } from '../src/config';

function env(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: 'development',
    ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com/',
    ACCESS_AUD: 'test-audience',
    ADMIN_ALLOWED_EMAILS: 'Admin@Example.com, second@example.com',
    ...overrides,
  } as Env;
}

describe('admin configuration', () => {
  test('normalizes authentication configuration once', () => {
    const config = getAdminConfig(env({ ADMIN_RATE_LIMIT_PER_MINUTE: '75' }));
    expect(config.accessTeamDomain).toBe('team.cloudflareaccess.com');
    expect(config.allowedEmails.has('admin@example.com')).toBeTrue();
    expect(config.rateLimitPerMinute).toBe(75);
  });

  test('rejects invalid admission configuration', () => {
    expect(() => getAdminConfig(env({ ADMIN_RATE_LIMIT_PER_MINUTE: '0' }))).toThrow(
      'ADMIN_RATE_LIMIT_PER_MINUTE',
    );
  });
});
