import { describe, expect, test } from 'bun:test';
import {
  ConnectNotionRequestSchema,
  ConnectorConnectionSchema,
  ConnectorConnectionStatusSchema,
} from '../src/features/connectors/schemas';

const UUID = '018f4c1e-6a7b-7c8d-9e0f-1a2b3c4d5e6f';
const NOW = '2026-08-12T00:00:00.000Z';

describe('connector schemas', () => {
  test('a Notion connection requires only the destination space', () => {
    expect(ConnectNotionRequestSchema.parse({ space_id: UUID })).toEqual({
      space_id: UUID,
    });
    expect(() => ConnectNotionRequestSchema.parse({})).toThrow();
  });

  test('connection status does not expose provider-specific states', () => {
    expect(ConnectorConnectionStatusSchema.parse('active')).toBe('active');
    expect(() => ConnectorConnectionStatusSchema.parse('INITIALIZING')).toThrow();
  });

  test('represents a pending connection before provider authorization completes', () => {
    expect(
      ConnectorConnectionSchema.parse({
        id: UUID,
        provider: 'notion',
        space_id: UUID,
        status: 'pending',
        display_name: null,
        connected_at: null,
        last_synced_at: null,
        created_at: NOW,
        updated_at: NOW,
      }),
    ).toMatchObject({
      provider: 'notion',
      status: 'pending',
      connected_at: null,
    });
  });
});
