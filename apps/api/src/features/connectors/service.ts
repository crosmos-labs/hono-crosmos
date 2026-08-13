import type {
  ConnectedAccountRetrieveResponse,
  ConnectedAccountStatus,
  CreateConnectedAccountLinkOptions,
} from '@composio/core';
import {
  type ConnectorConnection as ConnectorConnectionRow,
  connectorConnections,
  type Database,
  memorySpaces,
} from '@crosmos/db';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { AppError } from '../../lib/errors';
import type {
  ConnectorConnection,
  ConnectorConnectionStatus,
  ConnectorProvider,
} from './schemas';

const AUTH_BACKEND = 'composio';
const LIVE_CONNECTION_STATUSES: ConnectorConnectionStatus[] = [
  'pending',
  'active',
];
const LIVE_CONNECTION_CONSTRAINT = 'uq_connector_space_provider_live';

export interface ComposioConnectedAccountsClient {
  link(
    userId: string,
    authConfigId: string,
    options?: CreateConnectedAccountLinkOptions,
  ): Promise<{ id: string; redirectUrl?: string | null }>;

  get(id: string): Promise<ConnectedAccountRetrieveResponse>;
  delete(id: string): Promise<unknown>;
}

interface ScopedConnection {
  connection: ConnectorConnectionRow;
  spaceUuid: string;
}

export function mapComposioStatus(
  status: ConnectedAccountStatus,
  disabled = false,
): ConnectorConnectionStatus {
  if (disabled || status === 'INACTIVE' || status === 'REVOKED') {
    return 'disabled';
  }

  switch (status) {
    case 'ACTIVE':
      return 'active';
    case 'FAILED':
      return 'failed';
    case 'EXPIRED':
      return 'expired';
    case 'INITIALIZING':
    case 'INITIATED':
      return 'pending';
  }
}

export async function createNotionConnection(
  db: Database,
  connectedAccounts: ComposioConnectedAccountsClient,
  input: {
    orgId: number;
    spaceId: number;
    ownerUserId: number;
    composioUserId: string;
    authConfigId: string;
    callbackUrl: string;
  },
): Promise<{ connectionId: string; authorizationUrl: string }> {
  if (await hasLiveConnectorConnection(db, input.spaceId, 'notion')) {
    throw liveConnectionConflict();
  }

  const connectionRequest = await connectedAccounts.link(
    input.composioUserId,
    input.authConfigId,
    {
      callbackUrl: input.callbackUrl,
      allowMultiple: true,
    },
  );

  if (!connectionRequest.redirectUrl) {
    await connectedAccounts.delete(connectionRequest.id).catch(() => undefined);
    throw new AppError(
      502,
      'connector_authorization_unavailable',
      'Composio did not return an authorization URL',
    );
  }

  try {
    const [connection] = await db
      .insert(connectorConnections)
      .values({
        orgId: input.orgId,
        spaceId: input.spaceId,
        ownerUserId: input.ownerUserId,
        provider: 'notion',
        authBackend: AUTH_BACKEND,
        authConnectionId: connectionRequest.id,
        status: 'pending',
      })
      .returning({ uuid: connectorConnections.uuid });

    if (!connection) {
      throw new Error('Failed to create connector connection');
    }

    return {
      connectionId: connection.uuid,
      authorizationUrl: connectionRequest.redirectUrl,
    };
  } catch (error) {
    await connectedAccounts.delete(connectionRequest.id).catch(() => undefined);
    if (isConstraintViolation(error, LIVE_CONNECTION_CONSTRAINT)) {
      throw liveConnectionConflict();
    }
    throw error;
  }
}

async function hasLiveConnectorConnection(
  db: Database,
  spaceId: number,
  provider: ConnectorProvider,
): Promise<boolean> {
  const [connection] = await db
    .select({ id: connectorConnections.id })
    .from(connectorConnections)
    .where(
      and(
        eq(connectorConnections.spaceId, spaceId),
        eq(connectorConnections.provider, provider),
        inArray(connectorConnections.status, LIVE_CONNECTION_STATUSES),
      ),
    )
    .limit(1);

  return connection !== undefined;
}

function liveConnectionConflict(): AppError {
  return new AppError(
    409,
    'connector_already_connected',
    'This space already has a live Notion connection',
  );
}

function isConstraintViolation(error: unknown, constraint: string): boolean {
  let current: unknown = error;

  for (let depth = 0; depth < 4 && isRecord(current); depth += 1) {
    const constraintName = current.constraint_name ?? current.constraint;
    if (current.code === '23505' && constraintName === constraint) {
      return true;
    }
    current = current.cause;
  }

  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function listConnectorConnections(
  db: Database,
  input: {
    orgId: number;
    spaceId?: number;
    provider?: ConnectorProvider;
  },
): Promise<ConnectorConnection[]> {
  const rows = await db
    .select({
      connection: connectorConnections,
      spaceUuid: memorySpaces.uuid,
    })
    .from(connectorConnections)
    .innerJoin(memorySpaces, eq(connectorConnections.spaceId, memorySpaces.id))
    .where(
      and(
        eq(connectorConnections.orgId, input.orgId),
        isNull(memorySpaces.deletedAt),
        input.spaceId === undefined
          ? undefined
          : eq(connectorConnections.spaceId, input.spaceId),
        input.provider === undefined
          ? undefined
          : eq(connectorConnections.provider, input.provider),
      ),
    )
    .orderBy(desc(connectorConnections.createdAt));

  return rows.map(toConnectorResponse);
}

export async function refreshConnectorConnection(
  db: Database,
  connectedAccounts: ComposioConnectedAccountsClient,
  input: { orgId: number; connectionUuid: string; scopedSpaceId?: number },
): Promise<ConnectorConnection> {
  const scoped = await getScopedConnection(db, input);
  const remote = await connectedAccounts.get(scoped.connection.authConnectionId);

  if (remote.toolkit.slug !== scoped.connection.provider) {
    throw new AppError(
      502,
      'connector_provider_mismatch',
      'Connected account does not match the connector provider',
    );
  }

  const status = mapComposioStatus(remote.status, remote.isDisabled);
  const now = new Date();
  const [updated] = await db
    .update(connectorConnections)
    .set({
      status,
      connectedAt:
        status === 'active' ? (scoped.connection.connectedAt ?? now) : undefined,
      updatedAt: now,
    })
    .where(eq(connectorConnections.id, scoped.connection.id))
    .returning();

  if (!updated) {
    throw new Error('Failed to update connector connection');
  }

  return toConnectorResponse({ connection: updated, spaceUuid: scoped.spaceUuid });
}

export async function disconnectConnectorConnection(
  db: Database,
  connectedAccounts: ComposioConnectedAccountsClient,
  input: { orgId: number; connectionUuid: string; scopedSpaceId?: number },
): Promise<void> {
  const scoped = await getScopedConnection(db, input);

  if (scoped.connection.status !== 'disabled') {
    await connectedAccounts.delete(scoped.connection.authConnectionId);
    await db
      .update(connectorConnections)
      .set({ status: 'disabled', updatedAt: new Date() })
      .where(eq(connectorConnections.id, scoped.connection.id));
  }
}

async function getScopedConnection(
  db: Database,
  input: { orgId: number; connectionUuid: string; scopedSpaceId?: number },
): Promise<ScopedConnection> {
  const [row] = await db
    .select({
      connection: connectorConnections,
      spaceUuid: memorySpaces.uuid,
    })
    .from(connectorConnections)
    .innerJoin(memorySpaces, eq(connectorConnections.spaceId, memorySpaces.id))
    .where(
      and(
        eq(connectorConnections.orgId, input.orgId),
        eq(connectorConnections.uuid, input.connectionUuid),
        isNull(memorySpaces.deletedAt),
        input.scopedSpaceId === undefined
          ? undefined
          : eq(connectorConnections.spaceId, input.scopedSpaceId),
      ),
    )
    .limit(1);

  if (!row) {
    throw new AppError(404, 'connector_not_found', 'Connector not found');
  }

  return row;
}

function toConnectorResponse(row: ScopedConnection): ConnectorConnection {
  return {
    id: row.connection.uuid,
    provider: row.connection.provider as ConnectorProvider,
    space_id: row.spaceUuid,
    status: row.connection.status as ConnectorConnectionStatus,
    display_name: row.connection.displayName,
    connected_at: row.connection.connectedAt?.toISOString() ?? null,
    last_synced_at: row.connection.lastSyncedAt?.toISOString() ?? null,
    created_at: row.connection.createdAt.toISOString(),
    updated_at: row.connection.updatedAt.toISOString(),
  };
}
