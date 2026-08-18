import { describe, expect, test } from 'bun:test';
import {
  parseBoolean,
  parseDeploymentEnvironment,
  parseEnum,
  parseInteger,
  requireConfig,
} from '../src/config';

describe('runtime configuration parsing', () => {
  test('accepts all represented deployment environments', () => {
    expect(parseDeploymentEnvironment('development')).toBe('development');
    expect(parseDeploymentEnvironment('staging')).toBe('staging');
    expect(parseDeploymentEnvironment('production')).toBe('production');
  });

  test('rejects invalid values instead of silently weakening configuration', () => {
    expect(() => parseDeploymentEnvironment('test')).toThrow('ENVIRONMENT');
    expect(() => parseInteger('0', 'LIMIT', 10, { min: 1 })).toThrow('LIMIT');
    expect(() => parseBoolean('yes', 'ENABLED', true)).toThrow('ENABLED');
    expect(() => parseEnum('other', 'PROVIDER', ['a', 'b'] as const, 'a')).toThrow(
      'PROVIDER',
    );
    expect(() => requireConfig(' ', 'API_KEY')).toThrow('API_KEY');
  });
});
