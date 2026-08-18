import {
  parseDeploymentEnvironment,
  parseInteger,
  requireConfig,
  type DeploymentEnvironment,
} from '@crosmos/runtime';
import type { Env } from './bindings';

export interface AdminConfig {
  environment: DeploymentEnvironment;
  accessTeamDomain: string;
  accessAudience: string;
  allowedEmails: ReadonlySet<string>;
  rateLimitPerMinute: number;
}

const cache = new WeakMap<Env, AdminConfig>();

export function getAdminConfig(env: Env): AdminConfig {
  const cached = cache.get(env);
  if (cached) return cached;
  const allowedEmails = new Set(
    requireConfig(env.ADMIN_ALLOWED_EMAILS, 'ADMIN_ALLOWED_EMAILS')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  if (allowedEmails.size === 0) {
    throw new Error('ADMIN_ALLOWED_EMAILS must contain at least one address');
  }
  const config: AdminConfig = {
    environment: parseDeploymentEnvironment(env.ENVIRONMENT),
    accessTeamDomain: requireConfig(env.ACCESS_TEAM_DOMAIN, 'ACCESS_TEAM_DOMAIN')
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, ''),
    accessAudience: requireConfig(env.ACCESS_AUD, 'ACCESS_AUD'),
    allowedEmails,
    rateLimitPerMinute: parseInteger(
      env.ADMIN_RATE_LIMIT_PER_MINUTE,
      'ADMIN_RATE_LIMIT_PER_MINUTE',
      60,
      { min: 1 },
    ),
  };
  cache.set(env, config);
  return config;
}
