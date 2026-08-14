import { afterAll, describe, expect, test } from 'bun:test';
import { sources, type Database } from '@crosmos/db';
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

afterAll(async () => {
  if (database) await resetTestData(database);
});

async function ingestFixture(chunkBudgetRemaining?: number) {
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
  const vectorStore = new MemoryVectorStore();
  let remaining = 1;
  let invocations = 0;
  while (remaining > 0) {
    const result = await ingestSource({
      db: database!,
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
      chunkBudgetRemaining,
    });
    remaining = result.remainingChunkCount;
    invocations += 1;
    if (invocations > 10) throw new Error('Continuation fixture did not complete');
  }

  const memoryRows = await database!.execute(sql`
    select content, memory_type, speaker_role, importance_score,
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
  const entityRows = await database!.execute(sql`
    select name, entity_type
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
    memoryRows,
    citations,
    entityRows,
    edgeRows,
    vectors: vectorStore.toJSON(),
    sourceMeta: sourceState!.meta,
  };
}

describeDb('continuation-split ingestion equivalence', () => {
  test('two checkpointed invocations produce the single-shot artifacts exactly', async () => {
    const singleShot = await ingestFixture();
    const continued = await ingestFixture(1);

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
});
