import { createRoute } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { HonoEnv } from '../../bindings';
import { getDb } from '../../db';
import { getCredentialBackends } from '../../integrations/connectors';
import { assertKeyScopeAllowsSpace } from '../../lib/key-scope';
import { createApiApp } from '../../lib/openapi';
import { ErrorResponseSchema } from '../../lib/zod-common';
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
  completeConnectorAuthorization,
  disconnectConnector,
  getConnectorConnection,
  listConnectorConnections,
  startNotionAuthorization,
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

const errorResponses = {
  400: {
    description: 'Bad request',
    content: { 'application/json': { schema: ErrorResponseSchema } },
  },
  401: {
    description: 'Unauthorized',
    content: { 'application/json': { schema: ErrorResponseSchema } },
  },
  404: {
    description: 'Not found',
    content: { 'application/json': { schema: ErrorResponseSchema } },
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
      502: {
        description: 'Connector authorization unavailable',
        content: { 'application/json': { schema: ErrorResponseSchema } },
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

    const result = await startNotionAuthorization(
      db,
      getCredentialBackends(c.env),
      {
        orgId: principal.orgId,
        spaceId: space.id,
        ownerUserId: principal.userId,
        viewerUserId: principal.userId,
        viewerUserUuid: principal.userUuid,
      },
    );

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
      viewerUserId: principal.userId,
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
      ...errorResponses,
    },
  }),
  async (c) => {
    const { connection_id: connectionUuid } = c.req.valid('param');
    const principal = connectorPrincipal(c);
    const connection = await getConnectorConnection(getDb(c), {
      orgId: principal.orgId,
      viewerUserId: principal.userId,
      connectionUuid,
      scopedSpaceId: c.var.scopedSpaceId,
    });
    return c.json(connection, 200);
  },
);

connectorRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/{connection_id}/complete',
    tags: ['connectors'],
    summary: 'Complete Connector Authorization',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requirePrincipal] as const,
    request: { params: ConnectorConnectionParamsSchema },
    responses: {
      200: {
        description: 'Connector authorization state reconciled',
        content: { 'application/json': { schema: ConnectorConnectionSchema } },
      },
      409: {
        description: 'This external account is already connected',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
      502: {
        description: 'Connector provider unavailable',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const { connection_id: connectionUuid } = c.req.valid('param');
    const principal = connectorPrincipal(c);
    const connection = await completeConnectorAuthorization(
      getDb(c),
      getCredentialBackends(c.env),
      {
        orgId: principal.orgId,
        viewerUserId: principal.userId,
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
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const { connection_id: connectionUuid } = c.req.valid('param');
    const principal = connectorPrincipal(c);
    await disconnectConnector(
      getDb(c),
      getCredentialBackends(c.env),
      {
        orgId: principal.orgId,
        viewerUserId: principal.userId,
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
