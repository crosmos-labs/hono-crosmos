import type { LLM } from '../integrations/llm';
import {
  MEMORY_EXTRACTION_SCHEMA,
  MEMORY_SYSTEM_PROMPT,
  buildMemoryUserPrompt,
  type MemoryUserPromptInput,
} from '../prompts/memories';
import {
  GRAPH_EXTRACTION_SCHEMA,
  GRAPH_SYSTEM_PROMPT,
  buildGraphUserPrompt,
} from '../prompts/graph';
import type {
  RawExtractedMemories,
  RawExtractedMemory,
  RawGraphExtraction,
  RawGraphResult,
} from './types';

export async function extractMemories(
  llm: LLM,
  input: MemoryUserPromptInput,
  modelOverride?: string,
): Promise<RawExtractedMemory[]> {
  const { data } = await llm.completeJson<RawExtractedMemories>({
    system: MEMORY_SYSTEM_PROMPT,
    user: buildMemoryUserPrompt(input),
    schema: {
      name: MEMORY_EXTRACTION_SCHEMA.name,
      schema: MEMORY_EXTRACTION_SCHEMA.schema as Record<string, unknown>,
    },
    model: modelOverride,
  });
  return Array.isArray(data?.memories) ? data.memories : [];
}

export async function extractGraph(
  llm: LLM,
  memories: { content: string }[],
  modelOverride?: string,
): Promise<RawGraphResult[]> {
  if (memories.length === 0) return [];
  const { data } = await llm.completeJson<RawGraphExtraction>({
    system: GRAPH_SYSTEM_PROMPT,
    user: buildGraphUserPrompt(memories),
    schema: {
      name: GRAPH_EXTRACTION_SCHEMA.name,
      schema: GRAPH_EXTRACTION_SCHEMA.schema as Record<string, unknown>,
    },
    model: modelOverride,
  });
  return Array.isArray(data?.results) ? data.results : [];
}
