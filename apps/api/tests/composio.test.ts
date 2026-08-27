import { describe, expect, test } from 'bun:test';
import { Composio, type ConnectedAccountStatus } from '@composio/core';
import type { Env } from '../src/bindings';
import { getCredentialBackends } from '../src/integrations/connectors';
import {
  ComposioBackend,
  type ComposioClient,
  createComposioClient,
  mapComposioStatus,
} from '../src/integrations/connectors/composio';

function mockComposio(status: ConnectedAccountStatus = 'ACTIVE') {
  const calls = {
    links: [] as unknown[],
    retrieved: [] as string[],
    deleted: [] as string[],
    proxy: [] as unknown[],
  };
  const client: ComposioClient = {
    connectedAccounts: {
      async link(userId, authConfigId, options) {
        calls.links.push({ userId, authConfigId, options });
        return {
          id: 'ca_notion',
          redirectUrl: 'https://connect.composio.dev/link/new',
        };
      },
      async get(id) {
        calls.retrieved.push(id);
        return {
          id,
          status,
          statusReason: null,
          toolkit: { slug: 'notion' },
          authConfig: {
            id: 'ac_notion',
            isComposioManaged: true,
            isDisabled: false,
          },
          isDisabled: false,
          createdAt: '2026-08-27T00:00:00.000Z',
          updatedAt: '2026-08-27T00:00:00.000Z',
        };
      },
      async delete(id) {
        calls.deleted.push(id);
      },
    },
    tools: {
      async proxyExecute(input) {
        calls.proxy.push(input);
        return {
          status: 200,
          data: {
            object: 'user',
            type: 'bot',
            bot: {
              workspace_id: 'workspace-123',
              workspace_name: 'Crosmos',
            },
          },
        };
      },
    },
  };
  const backend = new ComposioBackend(client, {
    callbackUrl: 'https://app.crosmos.dev/connectors/callback',
    notionAuthConfigId: 'ac_notion',
  });
  return { backend, client, calls };
}

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
  });

  test('requires OAuth configuration only when beginning a new grant', () => {
    const backends = getCredentialBackends({
      COMPOSIO_API_KEY: 'secret',
    } as Env);

    expect(() => backends.get('composio')).not.toThrow();
    expect(() => backends.forProvider('notion')).toThrow(
      'Notion connector is not configured',
    );
  });

  test('begins Notion authorization using adapter-owned configuration', async () => {
    const { backend, calls } = mockComposio();

    await expect(
      backend.begin({ provider: 'notion', userId: 'user-uuid' }),
    ).resolves.toEqual({
      ref: 'ca_notion',
      authorizationUrl: 'https://connect.composio.dev/link/new',
    });
    expect(calls.links).toEqual([
      {
        userId: 'user-uuid',
        authConfigId: 'ac_notion',
        options: {
          callbackUrl: 'https://app.crosmos.dev/connectors/callback',
          allowMultiple: true,
        },
      },
    ]);
  });

  test('completes active authorization with workspace identity', async () => {
    const { backend, calls } = mockComposio();

    await expect(backend.complete('ca_notion')).resolves.toEqual({
      provider: 'notion',
      status: 'active',
      identity: {
        externalAccountId: 'workspace-123',
        displayName: 'Crosmos',
      },
    });
    expect(calls.proxy).toEqual([
      {
        endpoint: '/v1/users/me',
        method: 'GET',
        connectedAccountId: 'ca_notion',
        parameters: [
          {
            in: 'header',
            name: 'Notion-Version',
            value: '2026-03-11',
          },
        ],
      },
    ]);
  });

  test('does not fetch identity while authorization is pending', async () => {
    const { backend, calls } = mockComposio('INITIATED');

    await expect(backend.complete('ca_notion')).resolves.toEqual({
      provider: 'notion',
      status: 'pending',
    });
    expect(calls.proxy).toEqual([]);
  });

  test('rejects an active response without a workspace id', async () => {
    const { backend, client } = mockComposio();
    client.tools.proxyExecute = async () => ({
      status: 200,
      data: { bot: { workspace_name: 'Crosmos' } },
    });

    await expect(backend.complete('ca_notion')).rejects.toThrow('workspace_id');
  });

  test('maps Composio states inside the adapter boundary', () => {
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
