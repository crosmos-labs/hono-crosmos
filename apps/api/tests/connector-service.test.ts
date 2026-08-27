import { describe, expect, test } from 'bun:test';
import type {
  ConnectorConnection as ConnectorConnectionRow,
  Database,
} from '@crosmos/db';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  completeConnectorAuthorization,
  getConnectorConnection,
  startNotionAuthorization,
  viewerScopeFilter,
} from '../src/features/connectors/service';
import type {
  CredentialBackend,
  CredentialBackends,
  CredentialCompletion,
  CredentialState,
} from '../src/integrations/connectors';

const START_INPUT = {
  orgId: 1,
  spaceId: 2,
  ownerUserId: 3,
  viewerUserId: 3,
  viewerUserUuid: 'user-uuid',
};

const STORED_CONNECTION: ConnectorConnectionRow = {
  id: 10,
  uuid: '018f4c1e-6a7b-7c8d-9e0f-1a2b3c4d5e6f',
  orgId: 1,
  spaceId: 2,
  ownerUserId: 3,
  viewerUserId: 3,
  provider: 'notion',
  authBackend: 'composio',
  authConnectionId: 'ca_notion',
  externalAccountId: null,
  displayName: null,
  status: 'pending',
  connectedAt: null,
  lastSyncedAt: null,
  createdAt: new Date('2026-08-27T00:00:00.000Z'),
  updatedAt: new Date('2026-08-27T00:00:00.000Z'),
};

function mockCredentials(input: {
  completion?: CredentialCompletion;
  state?: CredentialState;
  completeError?: unknown;
  revokeError?: unknown;
} = {}) {
  const calls = {
    backendIds: [] as string[],
    begin: [] as Array<{ provider: string; userId: string }>,
    complete: [] as string[],
    status: [] as string[],
    revoke: [] as string[],
  };
  const backend: CredentialBackend = {
    id: 'composio',
    async begin(beginInput) {
      calls.begin.push(beginInput);
      return {
        ref: 'ca_new',
        authorizationUrl: 'https://connect.composio.dev/link/new',
      };
    },
    async complete(ref) {
      calls.complete.push(ref);
      if (input.completeError) throw input.completeError;
      return input.completion ?? { provider: 'notion', status: 'pending' };
    },
    async status(ref) {
      calls.status.push(ref);
      return input.state ?? { provider: 'notion', status: 'active' };
    },
    async revoke(ref) {
      calls.revoke.push(ref);
      if (input.revokeError) throw input.revokeError;
    },
  };
  const credentials: CredentialBackends = {
    get(id) {
      calls.backendIds.push(id);
      if (id !== backend.id) throw new Error(`Unexpected backend: ${id}`);
      return backend;
    },
    forProvider(provider) {
      calls.backendIds.push(`provider:${provider}`);
      return backend;
    },
  };
  return { credentials, calls };
}

function mockInsertDb(input: { insertError?: unknown } = {}) {
  const inserted: Array<Record<string, unknown>> = [];
  const db = {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserted.push(values);
        return {
          returning: async () => {
            if (input.insertError) throw input.insertError;
            return [{ uuid: STORED_CONNECTION.uuid }];
          },
        };
      },
    }),
  } as unknown as Database;
  return { db, inserted };
}

function mockConnectionDb(input: {
  connection?: ConnectorConnectionRow;
  updateError?: unknown;
} = {}) {
  const connection = input.connection ?? STORED_CONNECTION;
  const updates: Array<Record<string, unknown>> = [];
  let returningCalls = 0;
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => [{ connection, spaceUuid: 'space-uuid' }],
          }),
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return {
          where: () => ({
            returning: async () => {
              returningCalls += 1;
              if (returningCalls === 1 && input.updateError) {
                throw input.updateError;
              }
              return [{ ...connection, ...values }];
            },
          }),
        };
      },
    }),
  } as unknown as Database;
  return { db, updates };
}

describe('startNotionAuthorization', () => {
  test('stores an opaque reference returned by the configured backend', async () => {
    const { credentials, calls } = mockCredentials();
    const { db, inserted } = mockInsertDb();

    await expect(
      startNotionAuthorization(db, credentials, START_INPUT),
    ).resolves.toEqual({
      connectionId: STORED_CONNECTION.uuid,
      authorizationUrl: 'https://connect.composio.dev/link/new',
    });
    expect(calls.begin).toEqual([
      { provider: 'notion', userId: 'user-uuid' },
    ]);
    expect(calls.backendIds).toEqual(['provider:notion']);
    expect(inserted).toEqual([
      {
        orgId: 1,
        spaceId: 2,
        ownerUserId: 3,
        viewerUserId: 3,
        provider: 'notion',
        authBackend: 'composio',
        authConnectionId: 'ca_new',
        status: 'pending',
      },
    ]);
  });

  test('revokes the remote authorization if the local insert fails', async () => {
    const { credentials, calls } = mockCredentials();
    const insertError = new Error('database unavailable');
    const { db } = mockInsertDb({ insertError });

    await expect(
      startNotionAuthorization(db, credentials, START_INPUT),
    ).rejects.toBe(insertError);
    expect(calls.revoke).toEqual(['ca_new']);
  });

  test('preserves backend failures while beginning authorization', async () => {
    const providerError = new Error('Composio unavailable');
    const { credentials } = mockCredentials();
    const backend = credentials.forProvider('notion');
    backend.begin = async () => {
      throw providerError;
    };
    const { db } = mockInsertDb();

    await expect(
      startNotionAuthorization(db, credentials, START_INPUT),
    ).rejects.toMatchObject({
      status: 502,
      code: 'connector_provider_unavailable',
      cause: providerError,
    });
  });
});

describe('viewerScopeFilter', () => {
  test('supports explicit viewers and owner fallback during backfill', () => {
    const query = new PgDialect().sqlToQuery(viewerScopeFilter(7));

    expect(query.sql).toBe(
      '("connector_connections"."viewer_user_id" = $1 or ("connector_connections"."viewer_user_id" is null and "connector_connections"."owner_user_id" = $2))',
    );
    expect(query.params).toEqual([7, 7]);
  });
});

describe('getConnectorConnection', () => {
  test('returns stored state without requiring a credential backend', async () => {
    const { db } = mockConnectionDb();

    await expect(
      getConnectorConnection(db, {
        orgId: 1,
        viewerUserId: 3,
        connectionUuid: STORED_CONNECTION.uuid,
      }),
    ).resolves.toMatchObject({
      id: STORED_CONNECTION.uuid,
      status: 'pending',
      display_name: null,
    });
  });
});

describe('completeConnectorAuthorization', () => {
  const input = {
    orgId: 1,
    viewerUserId: 3,
    connectionUuid: STORED_CONNECTION.uuid,
  };

  test('persists account identity when authorization becomes active', async () => {
    const { db, updates } = mockConnectionDb();
    const { credentials, calls } = mockCredentials({
      completion: {
        provider: 'notion',
        status: 'active',
        identity: {
          externalAccountId: 'workspace-123',
          displayName: 'Crosmos',
        },
      },
    });

    await expect(
      completeConnectorAuthorization(db, credentials, input),
    ).resolves.toMatchObject({ status: 'active', display_name: 'Crosmos' });
    expect(calls.complete).toEqual(['ca_notion']);
    expect(calls.backendIds).toEqual(['composio']);
    expect(updates[0]).toMatchObject({
      status: 'active',
      externalAccountId: 'workspace-123',
      displayName: 'Crosmos',
    });
  });

  test('persists pending state without inventing an identity', async () => {
    const { db, updates } = mockConnectionDb();
    const { credentials } = mockCredentials();

    await expect(
      completeConnectorAuthorization(db, credentials, input),
    ).resolves.toMatchObject({ status: 'pending', display_name: null });
    expect(updates[0]).toMatchObject({ status: 'pending' });
    expect(updates[0]?.externalAccountId).toBeUndefined();
  });

  test('uses the lightweight status call after identity is already known', async () => {
    const connection: ConnectorConnectionRow = {
      ...STORED_CONNECTION,
      externalAccountId: 'workspace-123',
      displayName: 'Crosmos',
      status: 'active',
    };
    const { db } = mockConnectionDb({ connection });
    const { credentials, calls } = mockCredentials();

    await completeConnectorAuthorization(db, credentials, input);

    expect(calls.complete).toEqual([]);
    expect(calls.status).toEqual(['ca_notion']);
  });

  test('preserves the provider failure as the public error cause', async () => {
    const providerError = new Error('Composio timeout');
    const { db } = mockConnectionDb();
    const { credentials } = mockCredentials({ completeError: providerError });

    await expect(
      completeConnectorAuthorization(db, credentials, input),
    ).rejects.toMatchObject({
      status: 502,
      code: 'connector_provider_unavailable',
      cause: providerError,
    });
  });

  test('fails and revokes the losing side of a duplicate connection', async () => {
    const uniqueViolation = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint_name: 'uq_connector_viewer_space_external_account',
    });
    const { db, updates } = mockConnectionDb({ updateError: uniqueViolation });
    const { credentials, calls } = mockCredentials({
      completion: {
        provider: 'notion',
        status: 'active',
        identity: {
          externalAccountId: 'workspace-123',
          displayName: 'Crosmos',
        },
      },
    });

    await expect(
      completeConnectorAuthorization(db, credentials, input),
    ).rejects.toMatchObject({
      status: 409,
      code: 'connector_account_already_connected',
    });
    expect(updates[1]).toMatchObject({ status: 'failed' });
    expect(calls.revoke).toEqual(['ca_notion']);
  });
});
