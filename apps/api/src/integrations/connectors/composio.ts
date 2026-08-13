import { Composio } from '@composio/core';
import type { Env } from '../../bindings';

export function createComposioClient(apiKey: string): Composio {
  if (apiKey.trim().length === 0) {
    throw new Error('COMPOSIO_API_KEY is required');
  }

  return new Composio({
    apiKey,
    allowTracking: false,
  });
}

export function getComposioClient(env: Env): Composio {
  if (!env.COMPOSIO_API_KEY) {
    throw new Error('COMPOSIO_API_KEY is required');
  }

  return createComposioClient(env.COMPOSIO_API_KEY);
}
