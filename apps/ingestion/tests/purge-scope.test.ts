/**
 * P0-B — resumed-batch purge boundaries.
 *
 * `purgeSourceArtifacts` is the idempotency purge that runs before a (re-)ingest
 * of a source. When the batched pipeline resumes a large source it passes the
 * durable checkpoint as `minSequence`, meaning "undo only the partially-written
 * tail". The chunk discovery query honours that, but the final chunk delete used
 * to be keyed on `source_id`, wiping every chunk of the source.
 *
 * That is not a cosmetic scope bug. `chunk_memories` cascades with the chunk, so
 * deleting a pre-checkpoint chunk severs the citation linking an already-
 * committed memory to its evidence — and, because the purge rediscovers memories
 * by walking chunks, it also makes that memory permanently undiscoverable by any
 * later purge. These tests pin the surviving rows, not the call sequence.
 */
import { describe, expect, test } from 'bun:test';
import {
  chunkMemories,
  chunks,
  edges,
  memories,
  memoryEntities,
  type Database,
} from '@crosmos/db';
import type { VectorStore } from '@crosmos/vector';
import { purgeSourceArtifacts } from '../src/ingestion/pipeline';
import { asDatabase, FakeDb } from './helpers/fake-db';

const SOURCE_ID = 42;
const OTHER_SOURCE_ID = 43;

/**
 * A source split into 10 chunks, sequences 0..9. Each chunk cites exactly one
 * memory (memory id = 100 + sequence). Sequences 0..7 are "already committed";
 * a prior invocation died partway through 8..9. A neighbouring source (43) is
 * seeded throughout so every assertion also proves cross-source isolation.
 */
function seed() {
  const chunkRows = Array.from({ length: 10 }, (_, sequence) => ({
    id: sequence + 1,
    sourceId: SOURCE_ID,
    sequence,
  }));
  const otherChunk = { id: 99, sourceId: OTHER_SOURCE_ID, sequence: 0 };

  const db = new FakeDb({
    tables: [
      { table: chunks, rows: [...chunkRows, otherChunk] },
      {
        table: chunkMemories,
        rows: [
          ...chunkRows.map((c) => ({
            id: c.id,
            chunkId: c.id,
            memoryId: 100 + c.sequence,
          })),
          { id: 99, chunkId: 99, memoryId: 999 },
        ],
      },
      {
        table: memories,
        rows: [
          ...chunkRows.map((c) => ({ id: 100 + c.sequence })),
          { id: 999 },
        ],
      },
      {
        table: memoryEntities,
        rows: [
          ...chunkRows.map((c) => ({ id: c.id, memoryId: 100 + c.sequence, entityId: 1 })),
          { id: 99, memoryId: 999, entityId: 1 },
        ],
      },
      {
        table: edges,
        rows: [
          ...chunkRows.map((c) => ({ id: c.id, memoryId: 100 + c.sequence })),
          { id: 99, memoryId: 999 },
        ],
      },
    ],
    cascades: {
      // Mirrors the real FK actions: memories cascade their junctions, chunks
      // cascade chunk_memories, and edges.memory_id is ON DELETE SET NULL
      // (which is exactly why the purge deletes edges explicitly first).
      memories: [
        { table: chunkMemories, foreignKey: 'memoryId', parentKey: 'id', action: 'cascade' },
        { table: memoryEntities, foreignKey: 'memoryId', parentKey: 'id', action: 'cascade' },
        { table: edges, foreignKey: 'memoryId', parentKey: 'id', action: 'set null' },
      ],
      chunks: [
        { table: chunkMemories, foreignKey: 'chunkId', parentKey: 'id', action: 'cascade' },
      ],
    },
  });
  return db;
}

function fakeVectorStore(): VectorStore & { deleted: number[][] } {
  const deleted: number[][] = [];
  return {
    persistsInColumn: false,
    deleted,
    deleteByIds: async (_collection: string, ids: number[]) => {
      deleted.push([...ids]);
    },
  } as unknown as VectorStore & { deleted: number[][] };
}

const sequencesOf = (db: FakeDb) =>
  db
    .rows(chunks)
    .filter((r) => r.sourceId === SOURCE_ID)
    .map((r) => r.sequence as number)
    .sort((a, b) => a - b);

const memoryIdsOf = (db: FakeDb) =>
  db
    .rows(memories)
    .map((r) => r.id as number)
    .sort((a, b) => a - b);

describe('purgeSourceArtifacts — checkpoint scoping', () => {
  test('a resumed purge at checkpoint 8 leaves sequences 0..7 and their citations intact', async () => {
    const db = seed();
    const vectorStore = fakeVectorStore();

    const purged = await purgeSourceArtifacts(
      asDatabase<Database>(db),
      vectorStore,
      SOURCE_ID,
      8,
    );

    expect(purged).toBe(2);
    // Only the partially-written tail is gone.
    expect(sequencesOf(db)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // ...and only its memories.
    expect(memoryIdsOf(db)).toEqual([100, 101, 102, 103, 104, 105, 106, 107, 999]);

    // The citation links for the committed chunks survive. This is the assertion
    // the old `delete(chunks).where(eq(source_id))` failed: it cascaded every
    // chunk_memories row away while the memories stayed behind.
    const survivingCitations = db
      .rows(chunkMemories)
      .filter((r) => r.chunkId !== 99)
      .map((r) => r.memoryId as number)
      .sort((a, b) => a - b);
    expect(survivingCitations).toEqual([100, 101, 102, 103, 104, 105, 106, 107]);

    // Vectors for the purged memories are removed before their Postgres rows.
    expect(vectorStore.deleted).toEqual([[108, 109]]);
  });

  test('the neighbouring source is untouched', async () => {
    const db = seed();
    await purgeSourceArtifacts(asDatabase<Database>(db), fakeVectorStore(), SOURCE_ID, 8);

    expect(db.rows(chunks).filter((r) => r.sourceId === OTHER_SOURCE_ID)).toHaveLength(1);
    expect(db.rows(chunkMemories).filter((r) => r.chunkId === 99)).toHaveLength(1);
    expect(db.rows(memories).some((r) => r.id === 999)).toBe(true);
    expect(db.rows(edges).some((r) => r.id === 99 && r.memoryId === 999)).toBe(true);
  });

  test('edges are deleted, not orphaned by the SET NULL cascade', async () => {
    const db = seed();
    await purgeSourceArtifacts(asDatabase<Database>(db), fakeVectorStore(), SOURCE_ID, 8);

    // Rows 8 and 9 were deleted outright; nothing was left with a null memory_id.
    expect(db.rows(edges).map((r) => r.id).sort((a, b) => (a as number) - (b as number)))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 99]);
    expect(db.rows(edges).some((r) => r.memoryId === null)).toBe(false);
  });

  test('a full redrive (checkpoint 0) still purges every source-owned artifact', async () => {
    const db = seed();
    const vectorStore = fakeVectorStore();

    const purged = await purgeSourceArtifacts(
      asDatabase<Database>(db),
      vectorStore,
      SOURCE_ID,
      0,
    );

    expect(purged).toBe(10);
    expect(sequencesOf(db)).toEqual([]);
    expect(memoryIdsOf(db)).toEqual([999]);
    expect(vectorStore.deleted).toEqual([
      [100, 101, 102, 103, 104, 105, 106, 107, 108, 109],
    ]);
    // Cross-source isolation holds on the full path too.
    expect(db.rows(chunks)).toHaveLength(1);
  });

  test('repeating the purge is idempotent', async () => {
    const db = seed();
    const vectorStore = fakeVectorStore();

    const first = await purgeSourceArtifacts(
      asDatabase<Database>(db),
      vectorStore,
      SOURCE_ID,
      8,
    );
    const afterFirst = sequencesOf(db);
    const second = await purgeSourceArtifacts(
      asDatabase<Database>(db),
      vectorStore,
      SOURCE_ID,
      8,
    );

    expect(first).toBe(2);
    expect(second).toBe(0);
    expect(sequencesOf(db)).toEqual(afterFirst);
    // The second pass found no chunks, so it issued no vector delete either.
    expect(vectorStore.deleted).toHaveLength(1);
  });

  test('a purge above the highest sequence is a no-op', async () => {
    const db = seed();
    const vectorStore = fakeVectorStore();

    const purged = await purgeSourceArtifacts(
      asDatabase<Database>(db),
      vectorStore,
      SOURCE_ID,
      10,
    );

    expect(purged).toBe(0);
    expect(sequencesOf(db)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(memoryIdsOf(db)).toHaveLength(11);
    expect(vectorStore.deleted).toEqual([]);
  });

  test('a vector-store failure leaves the chunks discoverable for a retry', async () => {
    const db = seed();
    let calls = 0;
    const flaky = {
      persistsInColumn: false,
      deleteByIds: async () => {
        calls += 1;
        if (calls === 1) throw new Error('qdrant unavailable');
      },
    } as unknown as VectorStore;

    await expect(
      purgeSourceArtifacts(asDatabase<Database>(db), flaky, SOURCE_ID, 8),
    ).rejects.toThrow('qdrant unavailable');

    // Nothing was deleted, so the retry re-derives the same memory ids.
    expect(sequencesOf(db)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const purged = await purgeSourceArtifacts(
      asDatabase<Database>(db),
      flaky,
      SOURCE_ID,
      8,
    );
    expect(purged).toBe(2);
    expect(sequencesOf(db)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});
