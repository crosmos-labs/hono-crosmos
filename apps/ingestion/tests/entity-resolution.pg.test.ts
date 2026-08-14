import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { entities, type Database } from '@crosmos/db';
import {
  announceSkip,
  getTestDb,
  resetTestData,
  seedTenant,
  type Tenant,
} from '@crosmos/test-support';
import type { VectorStore } from '@crosmos/vector';
import { asc, eq } from 'drizzle-orm';
import { resolveEntities } from '../src/extractors/resolve-entity';

const database: Database | null = await getTestDb();
if (database === null) announceSkip('entity-resolution.pg.test.ts');
const describeDb = database === null ? describe.skip : describe;
let tenant: Tenant;

beforeEach(async () => {
  if (!database) return;
  await resetTestData(database);
  tenant = await seedTenant(database);
});

afterAll(async () => {
  if (database) await resetTestData(database);
});

function createEmbedder() {
  return {
    dimensions: 2,
    totalTokens: 0,
    async embed(text: string) {
      return { vector: [text.length, 1], usage: { promptTokens: 0, totalTokens: 0 } };
    },
    async embedBatch(texts: string[]) {
      return {
        vectors: texts.map((text) => [text.length, 1]),
        usage: { promptTokens: 0, totalTokens: 0 },
      };
    },
  };
}

function createVectorStore(): VectorStore {
  return {
    persistsInColumn: false,
    async upsert() {},
    async queryNearest() {
      throw new Error('Expected entity candidate lookup to use the batch operation');
    },
    async queryNearestBatch(_collection, vectors) {
      return vectors.map(() => []);
    },
    async fetchVectors() { return new Map(); },
    async deleteByIds() {},
  };
}

describeDb('bulk entity resolution concurrency', () => {
  test('simultaneous ingesters receive the same authoritative IDs without duplicates', async () => {
    const scope = {
      orgId: tenant.orgId,
      spaceId: tenant.spaceId,
      userId: tenant.userId,
    };
    const firstInput = [
      { name: 'Alice Example', entityType: 'person' },
      { name: 'Project Atlas', entityType: 'project' },
    ];
    const secondInput = [
      { name: 'alice example', entityType: 'person' },
      { name: 'PROJECT ATLAS', entityType: 'project' },
    ];

    const [first, second] = await Promise.all([
      resolveEntities(database!, scope, firstInput, createEmbedder(), createVectorStore()),
      resolveEntities(database!, scope, secondInput, createEmbedder(), createVectorStore()),
    ]);

    expect(first.map((result) => result.entityId)).toEqual(
      second.map((result) => result.entityId),
    );
    const rows = await database!
      .select({ id: entities.id, name: entities.name })
      .from(entities)
      .where(eq(entities.spaceId, tenant.spaceId))
      .orderBy(asc(entities.id));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.name.toLowerCase()))).toEqual(
      new Set(['alice example', 'project atlas']),
    );
  });
});
