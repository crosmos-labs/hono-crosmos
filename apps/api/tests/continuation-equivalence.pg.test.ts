import { afterAll, describe, expect, test } from 'bun:test';
import { edges, memoryEntities, sources, type Database } from '@crosmos/db';
import {
  announceSkip,
  FixtureStore,
  getTestDb,
  MemoryVectorStore,
  replayEmbedder,
  replayLLM,
  resetTestData,
  seedTenant,
} from '@crosmos/test-support';
import { sql } from 'drizzle-orm';
import { ingestSource } from '../../ingestion/src/ingestion/pipeline';
import { CORPUS } from './fixtures/corpus';

const database: Database | null = await getTestDb();
if (database === null) announceSkip('continuation-equivalence.pg.test.ts');
const describeDb = database === null ? describe.skip : describe;
const fixturePath = new URL('./fixtures/pipeline-fixtures.json', import.meta.url).pathname;
const fixtures = database === null ? null : await FixtureStore.load(fixturePath);
const DIMENSIONS = 1536;
const EMBED_MODEL = `openai-${DIMENSIONS}`;

class FailFirstVectorUpsertStore extends MemoryVectorStore {
  failures = 0;

  constructor(private readonly collectionToFail: 'memories' | 'entities') {
    super();
  }

  override async upsert(
    ...args: Parameters<MemoryVectorStore['upsert']>
  ): Promise<void> {
    if (args[0] === this.collectionToFail && this.failures === 0) {
      this.failures += 1;
      throw new Error(`forced ${this.collectionToFail} vector upsert failure`);
    }
    await super.upsert(...args);
  }
}

function failFirstWrite(
  databaseToWrap: Database,
  method: 'insert' | 'update',
  tableToFail: object,
  label: string,
) {
  const state = { failures: 0 };
  const terminal = method === 'insert' ? 'values' : 'set';
  const wrapped = new Proxy(databaseToWrap as object, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== method || typeof value !== 'function') {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (table: object) => {
        const builder = value.call(target, table) as object;
        if (table !== tableToFail) return builder;
        return new Proxy(builder, {
          get(builderTarget, builderProperty, builderReceiver) {
            const builderValue = Reflect.get(
              builderTarget,
              builderProperty,
              builderReceiver,
            );
            if (builderProperty !== terminal || typeof builderValue !== 'function') {
              return typeof builderValue === 'function'
                ? builderValue.bind(builderTarget)
                : builderValue;
            }
            return (...args: unknown[]) => {
              if (state.failures === 0) {
                state.failures += 1;
                throw new Error(`forced ${label} write failure`);
              }
              return builderValue.apply(builderTarget, args);
            };
          },
        });
      };
    },
  }) as Database;
  return { database: wrapped, state };
}

afterAll(async () => {
  if (database) await resetTestData(database);
});

async function ingestFixture(options: {
  chunkBudgetRemaining?: number;
  vectorStore?: MemoryVectorStore;
  retryFailures?: boolean;
  databaseOverride?: Database;
} = {}) {
  await resetTestData(database!);
  const tenant = await seedTenant(database!);
  const doc = CORPUS[0]!;
  const [source] = await database!.insert(sources).values({
    orgId: tenant.orgId,
    spaceId: tenant.spaceId,
    ownerUserId: tenant.userId,
    visibility: 'org',
    contentType: doc.contentType,
    content: doc.content,
    extractionStatus: 'processing',
    meta: { session_id: doc.sessionId, date: doc.date },
  }).returning({ id: sources.id });
  const vectorStore = options.vectorStore ?? new MemoryVectorStore();
  let remaining = 1;
  let invocations = 0;
  let failedAttempts = 0;
  while (remaining > 0) {
    try {
      const result = await ingestSource({
        db: options.databaseOverride ?? database!,
        scope: {
          orgId: tenant.orgId,
          spaceId: tenant.spaceId,
          userId: tenant.userId,
        },
        sourceId: source!.id,
        llm: replayLLM(fixtures!) as never,
        embedder: replayEmbedder(fixtures!, DIMENSIONS, EMBED_MODEL) as never,
        vectorStore: vectorStore as never,
        chunkConcurrency: 1,
        chunkBudgetRemaining: options.chunkBudgetRemaining,
      });
      remaining = result.remainingChunkCount;
      invocations += 1;
    } catch (error) {
      failedAttempts += 1;
      if (!options.retryFailures) throw error;
    }
    if (invocations + failedAttempts > 10) {
      throw new Error('Continuation fixture did not complete');
    }
  }

  const memoryRows = await database!.execute<{ id: number; [key: string]: unknown }>(sql`
    select id, content, memory_type, speaker_role, importance_score,
           event_time::text, recorded_at::text
    from memories
    where space_id = ${tenant.spaceId}
    order by id`);
  const citations = await database!.execute(sql`
    select c.sequence, m.content
    from chunk_memories cm
    join chunks c on c.id = cm.chunk_id
    join memories m on m.id = cm.memory_id
    where c.source_id = ${source!.id}
    order by c.sequence, m.id`);
  const entityRows = await database!.execute<{ id: number; [key: string]: unknown }>(sql`
    select id, name, entity_type
    from entities
    where space_id = ${tenant.spaceId}
    order by lower(name), id`);
  const edgeRows = await database!.execute(sql`
    select se.name as source_name, e.relation_type, te.name as target_name,
           m.content as memory_content, e.confidence,
           e.valid_from::text, e.recorded_at::text
    from edges e
    join entities se on se.id = e.source_entity_id
    join entities te on te.id = e.target_entity_id
    left join memories m on m.id = e.memory_id
    where e.space_id = ${tenant.spaceId}
    order by se.name, e.relation_type, te.name, m.content`);
  const [sourceState] = await database!.execute<{ meta: Record<string, unknown> }>(sql`
    select meta from sources where id = ${source!.id}`);

  return {
    invocations,
    failedAttempts,
    memoryRows,
    citations,
    entityRows,
    edgeRows,
    vectors: vectorStore.toJSON(),
    sourceMeta: sourceState!.meta,
  };
}

describeDb('continuation-split ingestion equivalence', () => {
  const withoutId = <T extends { id: number }>(rows: T[]) =>
    rows.map(({ id: _id, ...row }) => row);
  const vectorValues = (
    run: Awaited<ReturnType<typeof ingestFixture>>,
    collection: 'memories' | 'entities',
  ) => (run.vectors[collection] ?? []).map(({ id: _id, ...item }) => item);
  const expectLogicalArtifacts = (
    recovered: Awaited<ReturnType<typeof ingestFixture>>,
    clean: Awaited<ReturnType<typeof ingestFixture>>,
  ) => {
    expect(withoutId(recovered.memoryRows)).toEqual(withoutId(clean.memoryRows));
    expect(recovered.citations).toEqual(clean.citations);
    expect(withoutId(recovered.entityRows)).toEqual(withoutId(clean.entityRows));
    expect(recovered.edgeRows).toEqual(clean.edgeRows);
    expect(vectorValues(recovered, 'memories')).toEqual(vectorValues(clean, 'memories'));
    expect(vectorValues(recovered, 'entities')).toEqual(vectorValues(clean, 'entities'));
    expect(recovered.sourceMeta).toEqual(clean.sourceMeta);
    expect(recovered.sourceMeta).not.toHaveProperty('ingest_next_sequence');
  };

  test('two checkpointed invocations produce the single-shot artifacts exactly', async () => {
    const singleShot = await ingestFixture();
    const continued = await ingestFixture({ chunkBudgetRemaining: 1 });

    expect(singleShot.invocations).toBe(1);
    expect(continued.invocations).toBe(2);
    expect(continued.memoryRows).toEqual(singleShot.memoryRows);
    expect(continued.citations).toEqual(singleShot.citations);
    expect(continued.entityRows).toEqual(singleShot.entityRows);
    expect(continued.edgeRows).toEqual(singleShot.edgeRows);
    expect(continued.vectors).toEqual(singleShot.vectors);
    expect(continued.sourceMeta).toEqual(singleShot.sourceMeta);
    expect(continued.sourceMeta).not.toHaveProperty('ingest_next_sequence');
  });

  test('a failed external vector write retries to the clean logical artifacts', async () => {
    const clean = await ingestFixture();
    const flakyStore = new FailFirstVectorUpsertStore('memories');
    const recovered = await ingestFixture({
      vectorStore: flakyStore,
      retryFailures: true,
    });
    expect(flakyStore.failures).toBe(1);
    expect(recovered.failedAttempts).toBe(1);
    expect(recovered.invocations).toBe(1);
    expectLogicalArtifacts(recovered, clean);
  });

  test('a post-persistence entity-vector failure reuses rows without duplicates', async () => {
    const clean = await ingestFixture();
    const flakyStore = new FailFirstVectorUpsertStore('entities');
    const recovered = await ingestFixture({
      vectorStore: flakyStore,
      retryFailures: true,
    });

    expect(flakyStore.failures).toBe(1);
    expect(recovered.failedAttempts).toBe(1);
    expect(recovered.invocations).toBe(1);
    expectLogicalArtifacts(recovered, clean);
  });

  test('link, edge, and checkpoint write failures recover without orphans', async () => {
    const clean = await ingestFixture();
    expect(clean.edgeRows.length).toBeGreaterThan(0);
    const phases = [
      { method: 'insert', table: memoryEntities, label: 'memory-entity link' },
      { method: 'insert', table: edges, label: 'edge' },
      { method: 'update', table: sources, label: 'checkpoint' },
    ] as const;

    for (const phase of phases) {
      const fault = failFirstWrite(database!, phase.method, phase.table, phase.label);
      const recovered = await ingestFixture({
        databaseOverride: fault.database,
        retryFailures: true,
      });
      expect(fault.state.failures).toBe(1);
      expect(recovered.failedAttempts).toBe(1);
      expect(recovered.invocations).toBe(1);
      expectLogicalArtifacts(recovered, clean);
    }
  });
});
