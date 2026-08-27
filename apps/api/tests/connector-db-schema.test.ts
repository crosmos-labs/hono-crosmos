import { describe, expect, test } from 'bun:test';
import { connectorConnections } from '@crosmos/db';
import { getTableConfig } from 'drizzle-orm/pg-core';

describe('connector connection database schema', () => {
  const config = getTableConfig(connectorConnections);

  test('defines the viewer principal column for the expand/backfill rollout', () => {
    const viewerColumn = config.columns.find(
      (column) => column.name === 'viewer_user_id',
    );

    expect(viewerColumn).toBeDefined();
    expect(viewerColumn?.notNull).toBe(false);
  });

  test('deduplicates an external account per viewer instead of per provider', () => {
    const indexNames = config.indexes.map((index) => index.config.name);

    expect(indexNames).toContain('uq_connector_viewer_space_external_account');
    expect(indexNames).not.toContain('uq_connector_space_provider_live');
    expect(indexNames).not.toContain('uq_connector_space_external_account');
  });
});
