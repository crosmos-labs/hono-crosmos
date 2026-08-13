import { describe, expect, test } from 'bun:test';
import { Composio } from '@composio/core';
import { mapComposioStatus } from '../src/features/connectors/service';
import {
  createComposioClient,
  getComposioClient,
} from '../src/integrations/connectors/composio';

describe('Composio integration', () => {
  test('creates the official SDK client', () => {
    const client = createComposioClient('secret');

    expect(client).toBeInstanceOf(Composio);
    expect(client.connectedAccounts).toBeDefined();
  });

  test('requires a configured API key', () => {
    expect(() => createComposioClient('  ')).toThrow(
      'COMPOSIO_API_KEY is required',
    );
    expect(() => getComposioClient({} as never)).toThrow(
      'COMPOSIO_API_KEY is required',
    );
  });

  test('maps Composio states to public connector states', () => {
    expect(mapComposioStatus('INITIALIZING')).toBe('pending');
    expect(mapComposioStatus('INITIATED')).toBe('pending');
    expect(mapComposioStatus('ACTIVE')).toBe('active');
    expect(mapComposioStatus('FAILED')).toBe('failed');
    expect(mapComposioStatus('EXPIRED')).toBe('expired');
    expect(mapComposioStatus('INACTIVE')).toBe('disabled');
    expect(mapComposioStatus('REVOKED')).toBe('disabled');
    expect(mapComposioStatus('ACTIVE', true)).toBe('disabled');
  });
});
