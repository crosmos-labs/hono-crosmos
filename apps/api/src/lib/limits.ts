import type { Env } from '../bindings';
import { getApiConfig, type OperationalLimits } from '../config';

export type { OperationalLimits } from '../config';

export function getOperationalLimits(env: Env): OperationalLimits {
  return getApiConfig(env).limits;
}
