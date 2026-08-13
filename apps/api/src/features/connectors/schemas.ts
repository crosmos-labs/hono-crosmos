import { z } from '@hono/zod-openapi';
import { IsoDateTimeSchema, UuidSchema } from '../../lib/zod-common';

// Add providers here only when their connector is actually available.
export const ConnectorProviderSchema = z
  .enum(['notion'])
  .openapi('ConnectorProvider');

export type ConnectorProvider = z.infer<typeof ConnectorProviderSchema>;

// Public Crosmos states; Composio-specific states are mapped at the boundary.
export const ConnectorConnectionStatusSchema = z
  .enum(['pending', 'active', 'expired', 'failed', 'disabled'])
  .openapi('ConnectorConnectionStatus');

export type ConnectorConnectionStatus = z.infer<
  typeof ConnectorConnectionStatusSchema
>;

export const ConnectNotionRequestSchema = z
  .object({
    space_id: UuidSchema,
  })
  .openapi('ConnectNotionRequest');

export type ConnectNotionRequest = z.infer<typeof ConnectNotionRequestSchema>;

export const ConnectNotionResponseSchema = z
  .object({
    connection_id: UuidSchema,
    authorization_url: z.string().url(),
  })
  .openapi('ConnectNotionResponse');

export const ConnectorConnectionSchema = z
  .object({
    id: UuidSchema,
    provider: ConnectorProviderSchema,
    space_id: UuidSchema,
    status: ConnectorConnectionStatusSchema,
    display_name: z.string().nullable(),
    connected_at: IsoDateTimeSchema.nullable(),
    last_synced_at: IsoDateTimeSchema.nullable(),
    created_at: IsoDateTimeSchema,
    updated_at: IsoDateTimeSchema,
  })
  .openapi('ConnectorConnection');

export type ConnectorConnection = z.infer<typeof ConnectorConnectionSchema>;

export const ConnectorConnectionListSchema = z
  .object({
    connections: z.array(ConnectorConnectionSchema),
    total: z.number().int().nonnegative(),
  })
  .openapi('ConnectorConnectionList');

export const ListConnectorConnectionsQuerySchema = z.object({
  space_id: UuidSchema.optional(),
  provider: ConnectorProviderSchema.optional(),
});

export const ConnectorConnectionParamsSchema = z.object({
  connection_id: UuidSchema,
});

export const DisconnectConnectorResponseSchema = z
  .object({
    connection_id: UuidSchema,
    disconnected: z.literal(true),
  })
  .openapi('DisconnectConnectorResponse');
