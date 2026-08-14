import { describe, expect, test } from 'bun:test';
import type { Database } from '@crosmos/db';
import { createStageRecorder, type Logger } from '@crosmos/observability';
import type { VectorStore } from '@crosmos/vector';
import type { Embedder } from '../src/integrations/embeddings';
import {
  prepareExistingMemoryHints,
} from '../src/ingestion/pipeline';
import type { SourceChunk } from '../src/ingestion/chunking';

describe('batched existing-memory hints', () => {
  test('splits once and gives only the failed half empty hints', async () => {
    const chunks: SourceChunk[] = [
      { sequence: 0, content: 'fail zero', context: null, chunker: 'recursive' },
      { sequence: 1, content: 'fail one', context: null, chunker: 'recursive' },
      { sequence: 2, content: 'keep two', context: null, chunker: 'recursive' },
      { sequence: 3, content: 'keep three', context: null, chunker: 'recursive' },
    ];
    const embeddingBatches: string[][] = [];
    const embedder = {
      dimensions: 2,
      totalTokens: 0,
      async embed() {
        throw new Error('The bounded hint phase must use embedBatch');
      },
      async embedBatch(texts: string[]) {
        embeddingBatches.push(texts);
        if (texts.length > 2 || texts.some((text) => text.startsWith('fail'))) {
          throw new Error('forced provider batch failure');
        }
        return {
          vectors: texts.map((_, index) => [index + 1, 1]),
          usage: { promptTokens: 0, totalTokens: 0 },
        };
      },
    } satisfies Embedder;
    let annCalls = 0;
    const vectorStore = {
      persistsInColumn: false,
      async upsert() {},
      async queryNearest() {
        throw new Error('The bounded hint phase must use queryNearestBatch');
      },
      async queryNearestBatch(_collection, vectors) {
        annCalls += 1;
        return vectors.map(() => [{ id: 7, score: 0.9 }]);
      },
      async fetchVectors() { return new Map(); },
      async deleteByIds() {},
    } satisfies VectorStore;
    const db = {
      select: () => ({
        from: () => ({
          where: async () => [{ id: 7, content: 'known memory' }],
        }),
      }),
    } as unknown as Database;
    const warnings: Array<Record<string, unknown>> = [];
    const logger = {
      warn(_event: string, fields: Record<string, unknown>) { warnings.push(fields); },
    } as unknown as Logger;

    const hints = await prepareExistingMemoryHints({
      db,
      scope: { orgId: 1, spaceId: 2, userId: 3 },
      chunks,
      embedder,
      vectorStore,
      stages: createStageRecorder({
        event: 'ingestion.stage_completed',
        metric: 'ingestion_stage',
      }),
      logger,
    });

    expect(embeddingBatches).toEqual([
      ['fail zero', 'fail one', 'keep two', 'keep three'],
      ['fail zero', 'fail one'],
      ['keep two', 'keep three'],
    ]);
    expect(annCalls).toBe(1);
    expect([...hints]).toEqual([
      [0, []],
      [1, []],
      [2, ['known memory']],
      [3, ['known memory']],
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.chunk_count).toBe(2);
  });
});
