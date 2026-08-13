import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { HonoEnv } from '../../bindings';
import { getDb } from '../../db';
import { getComposioClient } from '../../integrations/connectors/composio';
import { assertKeyScopeAllowsSpace } from '../../lib/key-scope';
import { createApiApp } from '../../lib/openapi';
import { requireAuth } from '../auth/middleware';
import { requirePrincipal } from '../auth/principal';
import { getSpaceByUuid } from '../spaces/service';
import {
  ConnectNotionRequestSchema,
  ConnectNotionResponseSchema,
  ConnectorConnectionListSchema,
  ConnectorConnectionParamsSchema,
  ConnectorConnectionSchema,
  DisconnectConnectorResponseSchema,
  ListConnectorConnectionsQuerySchema,
} from './schemas';
import {
  createNotionConnection,
  disconnectConnectorConnection,
  listConnectorConnections,
  refreshConnectorConnection,
} from './service';

export const connectorRoutes = createApiApp();

function connectorPrincipal(c: Context<HonoEnv>): {
  orgId: number;
  userId: number;
  userUuid: string;
} {
  const { activeOrgId, userId, userUuid } = c.var;
  if (activeOrgId == null || userId == null || userUuid == null) {
    throw new HTTPException(401, { message: 'Unauthenticated' });
  }
  return { orgId: activeOrgId, userId, userUuid };
}

const ErrorBody = z.object({ detail: z.string() }).openapi('ConnectorErrorBody');
const errorResponses = {
  400: {
    description: 'Bad request',
    content: { 'application/json': { schema: ErrorBody } },
  },
  401: {
    description: 'Unauthorized',
    content: { 'application/json': { schema: ErrorBody } },
  },
  404: {
    description: 'Not found',
    content: { 'application/json': { schema: ErrorBody } },
  },
};

connectorRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/notion/connect',
    tags: ['connectors'],
    summary: 'Connect Notion',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requirePrincipal] as const,
    request: {
      body: {
        content: { 'application/json': { schema: ConnectNotionRequestSchema } },
      },
    },
    responses: {
      201: {
        description: 'Notion authorization link created',
        content: {
          'application/json': { schema: ConnectNotionResponseSchema },
        },
      },
      409: {
        description: 'This space already has a live Notion connection',
        content: { 'application/json': { schema: ErrorBody } },
      },
      502: {
        description: 'Connector authorization unavailable',
        content: { 'application/json': { schema: ErrorBody } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const body = c.req.valid('json');
    const db = getDb(c);
    const principal = connectorPrincipal(c);
    const space = await getSpaceByUuid(db, body.space_id);
    if (!space || space.orgId !== principal.orgId) {
      throw new HTTPException(404, { message: 'Space not found' });
    }
    assertKeyScopeAllowsSpace(c, space.id);

    const authConfigId = c.env.COMPOSIO_NOTION_AUTH_CONFIG_ID;
    const callbackUrl = c.env.CONNECTOR_CALLBACK_URL;
    if (!authConfigId || !callbackUrl) {
      throw new Error('Notion connector is not configured');
    }

    const composio = getComposioClient(c.env);
    const result = await createNotionConnection(db, composio.connectedAccounts, {
      orgId: principal.orgId,
      spaceId: space.id,
      ownerUserId: principal.userId,
      composioUserId: principal.userUuid,
      authConfigId,
      callbackUrl,
    });

    return c.json(
      {
        connection_id: result.connectionId,
        authorization_url: result.authorizationUrl,
      },
      201,
    );
  },
);

connectorRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['connectors'],
    summary: 'List Connector Connections',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requirePrincipal] as const,
    request: { query: ListConnectorConnectionsQuerySchema },
    responses: {
      200: {
        description: 'Connector connections',
        content: {
          'application/json': { schema: ConnectorConnectionListSchema },
        },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const query = c.req.valid('query');
    const db = getDb(c);
    const principal = connectorPrincipal(c);
    let spaceId = c.var.scopedSpaceId;

    if (query.space_id) {
      const space = await getSpaceByUuid(db, query.space_id);
      if (!space || space.orgId !== principal.orgId) {
        throw new HTTPException(404, { message: 'Space not found' });
      }
      assertKeyScopeAllowsSpace(c, space.id);
      spaceId = space.id;
    }

    const connections = await listConnectorConnections(db, {
      orgId: principal.orgId,
      spaceId,
      provider: query.provider,
    });
    return c.json({ connections, total: connections.length }, 200);
  },
);

connectorRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/{connection_id}',
    tags: ['connectors'],
    summary: 'Get Connector Connection',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requirePrincipal] as const,
    request: { params: ConnectorConnectionParamsSchema },
    responses: {
      200: {
        description: 'Connector connection',
        content: { 'application/json': { schema: ConnectorConnectionSchema } },
      },
      502: {
        description: 'Connector provider unavailable',
        content: { 'application/json': { schema: ErrorBody } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const { connection_id: connectionUuid } = c.req.valid('param');
    const principal = connectorPrincipal(c);
    const composio = getComposioClient(c.env);
    const connection = await refreshConnectorConnection(
      getDb(c),
      composio.connectedAccounts,
      {
        orgId: principal.orgId,
        connectionUuid,
        scopedSpaceId: c.var.scopedSpaceId,
      },
    );
    return c.json(connection, 200);
  },
);

connectorRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/{connection_id}',
    tags: ['connectors'],
    summary: 'Disconnect Connector',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requirePrincipal] as const,
    request: { params: ConnectorConnectionParamsSchema },
    responses: {
      200: {
        description: 'Connector disconnected',
        content: {
          'application/json': { schema: DisconnectConnectorResponseSchema },
        },
      },
      502: {
        description: 'Connector provider unavailable',
        content: { 'application/json': { schema: ErrorBody } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const { connection_id: connectionUuid } = c.req.valid('param');
    const principal = connectorPrincipal(c);
    const composio = getComposioClient(c.env);
    await disconnectConnectorConnection(
      getDb(c),
      composio.connectedAccounts,
      {
        orgId: principal.orgId,
        connectionUuid,
        scopedSpaceId: c.var.scopedSpaceId,
      },
    );
    return c.json(
      { connection_id: connectionUuid, disconnected: true as const },
      200,
    );
  },
);
