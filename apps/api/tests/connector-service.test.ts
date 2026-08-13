import { describe, expect, test } from 'bun:test';
import type { Database } from '@crosmos/db';
import type { ComposioConnectedAccountsClient } from '../src/features/connectors/service';
import { createNotionConnection } from '../src/features/connectors/service';

const INPUT = {
  orgId: 1,
  spaceId: 2,
  ownerUserId: 3,
  composioUserId: 'user-uuid',
  authConfigId: 'ac_notion',
  callbackUrl: 'https://app.crosmos.dev/connectors/callback',
};

function mockConnectedAccounts() {
  const calls = { link: 0, deleted: [] as string[] };
  const client = {
    async link() {
      calls.link += 1;
      return {
        id: 'ca_new',
        redirectUrl: 'https://connect.composio.dev/link/new',
      };
    },
    async delete(id: string) {
      calls.deleted.push(id);
    },
  } as unknown as ComposioConnectedAccountsClient;
  return { client, calls };
}

function mockDb(input: {
  liveConnections: Array<{ id: number }>;
  insertError?: unknown;
}): Database {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => input.liveConnections,
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: async () => {
          if (input.insertError) throw input.insertError;
          return [{ uuid: '018f4c1e-6a7b-7c8d-9e0f-1a2b3c4d5e6f' }];
        },
      }),
    }),
  } as unknown as Database;
}

describe('createNotionConnection', () => {
  test('rejects an existing live Notion connection before creating OAuth state', async () => {
    const { client, calls } = mockConnectedAccounts();

    await expect(
      createNotionConnection(
        mockDb({ liveConnections: [{ id: 1 }] }),
        client,
        INPUT,
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: 'connector_already_connected',
    });
    expect(calls.link).toBe(0);
    expect(calls.deleted).toEqual([]);
  });

  test('maps a concurrent uniqueness race to conflict and removes the extra OAuth state', async () => {
    const { client, calls } = mockConnectedAccounts();
    const uniqueViolation = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint_name: 'uq_connector_space_provider_live',
    });

    await expect(
      createNotionConnection(
        mockDb({ liveConnections: [], insertError: uniqueViolation }),
        client,
        INPUT,
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: 'connector_already_connected',
    });
    expect(calls.link).toBe(1);
    expect(calls.deleted).toEqual(['ca_new']);
  });
});
