import {
  type ConnectorConnection as ConnectorConnectionRow,
  connectorConnections,
  type Database,
  memorySpaces,
} from '@crosmos/db';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import type {
  AuthorizationStart,
  CredentialBackend,
  CredentialBackends,
  CredentialCompletion,
  CredentialState,
} from '../../integrations/connectors/port';
import { AppError } from '../../lib/errors';
import type {
  ConnectorConnection,
  ConnectorConnectionStatus,
  ConnectorProvider,
} from './schemas';

const EXTERNAL_ACCOUNT_CONSTRAINT =
  'uq_connector_viewer_space_external_account';

interface AccessibleConnection {
  connection: ConnectorConnectionRow;
  spaceUuid: string;
}

export function viewerScopeFilter(viewerUserId: number) {
  return or(
    eq(connectorConnections.viewerUserId, viewerUserId),
    and(
      isNull(connectorConnections.viewerUserId),
      eq(connectorConnections.ownerUserId, viewerUserId),
    ),
  )!;
}

export async function startNotionAuthorization(
  db: Database,
  credentials: CredentialBackends,
  input: {
    orgId: number;
    spaceId: number;
    ownerUserId: number;
    viewerUserId: number;
    viewerUserUuid: string;
  },
): Promise<{ connectionId: string; authorizationUrl: string }> {
  const backend = credentials.forProvider('notion');
  let authorization: AuthorizationStart;
  try {
    authorization = await backend.begin({
      provider: 'notion',
      userId: input.viewerUserUuid,
    });
  } catch (cause) {
    throw new AppError(
      502,
      'connector_provider_unavailable',
      'Could not begin connector authorization',
      { cause },
    );
  }

  if (!authorization.authorizationUrl) {
    await backend.revoke(authorization.ref).catch(() => undefined);
    throw new AppError(
      502,
      'connector_authorization_unavailable',
      'The credential backend did not return an authorization URL',
    );
  }

  try {
    const [connection] = await db
      .insert(connectorConnections)
      .values({
        orgId: input.orgId,
        spaceId: input.spaceId,
        ownerUserId: input.ownerUserId,
        viewerUserId: input.viewerUserId,
        provider: 'notion',
        authBackend: backend.id,
        authConnectionId: authorization.ref,
        status: 'pending',
      })
      .returning({ uuid: connectorConnections.uuid });

    if (!connection) {
      throw new Error('Failed to create connector connection');
    }

    return {
      connectionId: connection.uuid,
      authorizationUrl: authorization.authorizationUrl,
    };
  } catch (error) {
    await backend.revoke(authorization.ref).catch(() => undefined);
    throw error;
  }
}

export async function listConnectorConnections(
  db: Database,
  input: {
    orgId: number;
    viewerUserId: number;
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
        viewerScopeFilter(input.viewerUserId),
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

  return rows.map(toPublicConnection);
}

export async function getConnectorConnection(
  db: Database,
  input: {
    orgId: number;
    viewerUserId: number;
    connectionUuid: string;
    scopedSpaceId?: number;
  },
): Promise<ConnectorConnection> {
  const accessibleConnection = await requireAccessibleConnection(db, input);
  return toPublicConnection(accessibleConnection);
}

export async function completeConnectorAuthorization(
  db: Database,
  credentials: CredentialBackends,
  input: {
    orgId: number;
    viewerUserId: number;
    connectionUuid: string;
    scopedSpaceId?: number;
  },
): Promise<ConnectorConnection> {
  const accessibleConnection = await requireAccessibleConnection(db, input);
  const connection = accessibleConnection.connection;
  const backend = credentials.get(connection.authBackend);
  let remote: CredentialCompletion | CredentialState;

  try {
    remote =
      connection.externalAccountId === null
        ? await backend.complete(connection.authConnectionId)
        : await backend.status(connection.authConnectionId);
  } catch (cause) {
    throw new AppError(
      502,
      'connector_provider_unavailable',
      'Could not complete connector authorization',
      { cause },
    );
  }

  if (remote.provider !== connection.provider) {
    throw new AppError(
      502,
      'connector_provider_mismatch',
      'Connected account does not match the connector provider',
    );
  }

  const identity = hasCompletedIdentity(remote) ? remote.identity : undefined;
  if (
    remote.status === 'active' &&
    connection.externalAccountId === null &&
    !identity
  ) {
    throw new AppError(
      502,
      'connector_identity_unavailable',
      'Could not identify the connected account',
    );
  }

  const now = new Date();
  let updated: ConnectorConnectionRow | undefined;
  try {
    [updated] = await db
      .update(connectorConnections)
      .set({
        status: remote.status,
        ...(identity
          ? {
              externalAccountId: identity.externalAccountId,
              displayName: identity.displayName,
            }
          : {}),
        connectedAt:
          remote.status === 'active'
            ? (connection.connectedAt ?? now)
            : undefined,
        updatedAt: now,
      })
      .where(eq(connectorConnections.id, connection.id))
      .returning();
  } catch (error) {
    if (isConstraintViolation(error, EXTERNAL_ACCOUNT_CONSTRAINT)) {
      await failDuplicateConnection(db, backend, connection);
      throw new AppError(
        409,
        'connector_account_already_connected',
        'This Notion workspace is already connected to the space',
      );
    }
    throw error;
  }

  if (!updated) {
    throw new Error('Failed to update connector connection');
  }

  return toPublicConnection({
    connection: updated,
    spaceUuid: accessibleConnection.spaceUuid,
  });
}

export async function disconnectConnector(
  db: Database,
  credentials: CredentialBackends,
  input: {
    orgId: number;
    viewerUserId: number;
    connectionUuid: string;
    scopedSpaceId?: number;
  },
): Promise<void> {
  const accessibleConnection = await requireAccessibleConnection(db, input);

  if (accessibleConnection.connection.status !== 'disabled') {
    const backend = credentials.get(
      accessibleConnection.connection.authBackend,
    );
    try {
      await backend.revoke(accessibleConnection.connection.authConnectionId);
    } catch (cause) {
      throw new AppError(
        502,
        'connector_provider_unavailable',
        'Could not revoke connector authorization',
        { cause },
      );
    }
    await db
      .update(connectorConnections)
      .set({ status: 'disabled', updatedAt: new Date() })
      .where(eq(connectorConnections.id, accessibleConnection.connection.id));
  }
}

async function failDuplicateConnection(
  db: Database,
  backend: CredentialBackend,
  connection: ConnectorConnectionRow,
): Promise<void> {
  await db
    .update(connectorConnections)
    .set({ status: 'failed', updatedAt: new Date() })
    .where(eq(connectorConnections.id, connection.id));

  try {
    await backend.revoke(connection.authConnectionId);
  } catch (cause) {
    throw new AppError(
      502,
      'connector_duplicate_cleanup_failed',
      'The duplicate connection could not be cleaned up',
      { cause },
    );
  }
}

async function requireAccessibleConnection(
  db: Database,
  input: {
    orgId: number;
    viewerUserId: number;
    connectionUuid: string;
    scopedSpaceId?: number;
  },
): Promise<AccessibleConnection> {
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
        viewerScopeFilter(input.viewerUserId),
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

function toPublicConnection(row: AccessibleConnection): ConnectorConnection {
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

function hasCompletedIdentity(
  state: CredentialCompletion | CredentialState,
): state is Extract<CredentialCompletion, { status: 'active' }> {
  return state.status === 'active' && 'identity' in state;
}
