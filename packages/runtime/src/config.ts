export type DeploymentEnvironment = 'development' | 'staging' | 'production';

export function parseDeploymentEnvironment(
  value: string | undefined,
): DeploymentEnvironment {
  if (value === 'development' || value === 'staging' || value === 'production') {
    return value;
  }
  throw new Error(
    `ENVIRONMENT must be development, staging, or production; received ${JSON.stringify(value)}`,
  );
}

export function parseEnum<const T extends readonly string[]>(
  value: string | undefined,
  name: string,
  allowed: T,
  fallback: T[number],
): T[number] {
  const resolved = value ?? fallback;
  if ((allowed as readonly string[]).includes(resolved)) return resolved as T[number];
  throw new Error(`${name} must be one of ${allowed.join(', ')}; received ${JSON.stringify(value)}`);
}

export function parseInteger(
  value: string | undefined,
  name: string,
  fallback: number,
  options: { min?: number; max?: number } = {},
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  const min = options.min ?? Number.MIN_SAFE_INTEGER;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(
      `${name} must be an integer between ${min} and ${max}; received ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}

export function parseBoolean(
  value: string | undefined,
  name: string,
  fallback: boolean,
): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be "true" or "false"; received ${JSON.stringify(value)}`);
}

export function requireConfig(value: string | undefined, name: string): string {
  const resolved = value?.trim();
  if (!resolved) throw new Error(`${name} is required by the selected provider`);
  return resolved;
}
