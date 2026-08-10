import { describe, expect, test } from 'bun:test';
import type { Database } from '@crosmos/db';
import type { VectorStore } from '@crosmos/vector';
import type { Embedder } from '../src/integrations/embeddings';
import type { LLM } from '../src/integrations/llm';
import { ingestSource } from '../src/ingestion/pipeline';

describe('existing-memory dedup', () => {
  test('accepts an empty extraction result without retrying without hints', async () => {
    const source = {
      id: 1,
      content: 'I like Rachit.',
      contentType: 'text',
      meta: null,
      ownerUserId: 7,
      visibility: 'private',
      tokenCount: 4,
    };

    let selectCalls = 0;
    const db = {
      select: () => {
        selectCalls += 1;
        if (selectCalls === 1) {
          return {
            from: () => ({
              where: () => ({ limit: async () => [source] }),
            }),
          };
        }
        return { from: () => ({ where: async () => [] }) };
      },
      update: () => ({ set: () => ({ where: async () => [] }) }),
    } as unknown as Database;

    const prompts: string[] = [];
    const llm = {
      defaultModel: 'test-model',
      totalTokens: 0,
      complete: async () => {
        throw new Error('Unexpected text completion');
      },
      completeJson: async (opts: { user: string }) => {
        prompts.push(opts.user);
        return {
          data: { memories: [] },
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      },
    } as unknown as LLM;

    const embedder = {
      dimensions: 3,
      totalTokens: 0,
      embed: async () => {
        throw new Error('Existing memories should skip the vector lookup');
      },
      embedBatch: async () => {
        throw new Error('Empty extraction should not be embedded');
      },
    } as unknown as Embedder;

    const vectorStore = {
      persistsInColumn: false,
      upsert: async () => {},
      queryNearest: async () => {
        throw new Error('Existing memories should skip the vector lookup');
      },
      fetchVectors: async () => new Map(),
      deleteByIds: async () => {},
    } as unknown as VectorStore;

    const result = await ingestSource({
      db,
      scope: { orgId: 2, spaceId: 3, userId: 7 },
      sourceId: source.id,
      llm,
      embedder,
      vectorStore,
      existingMemories: ['User likes Rachit.'],
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('User likes Rachit.');
    expect(result.memories).toEqual([]);
    expect(result.edges).toEqual([]);
  });
});
