/**
 * Graph extraction (Pass 2) prompt + JSON schema. Mirrors
 * `app/engine/prompts/graph.py`.
 *
 * Pass 2 receives the **content strings** of the memories produced by Pass 1
 * and asks the LLM to extract entities + relations per memory. Graph failure
 * is non-fatal: the pipeline still persists memories without graph data (see
 * docs/ingestion_migration/pipeline.md §Stage 3).
 */
import {
  CANONICAL_RELATIONS,
  RELATION_TYPES,
} from '../ontology/relation-types';
import { ENTITY_TYPE_NAMES } from '../ontology/entity-types';
import {
  ENTITY_NAME_MAX_LENGTH,
  ENTITY_NAME_MAX_WORDS,
  MIN_RELATION_CONFIDENCE,
} from '../constants';

function canonicalRelationBlock(): string {
  return CANONICAL_RELATIONS.map((name) => {
    const meta = RELATION_TYPES[name]!;
    return `- ${name} — ${meta.description}`;
  }).join('\n');
}

function entityTypeBlock(): string {
  return ENTITY_TYPE_NAMES.map((t) => `- ${t}`).join('\n');
}

export const GRAPH_SYSTEM_PROMPT = `You extract entities and relations from atomic memories for a knowledge graph.

ENTITY RULES:
- Entities are PROPER NOUNS only. People, organizations, technologies, projects, locations, named objects, named concepts.
- Activities, food orders, generic descriptions, quantities, dates, and generic nouns are NOT entities.
- Max ${ENTITY_NAME_MAX_WORDS} words per entity name; max ${ENTITY_NAME_MAX_LENGTH} characters.
- Use the exact entity type strings:
${entityTypeBlock()}

RELATION RULES:
- Subject and object of every relation MUST appear in that memory's "entities" list.
- Relation types in SCREAMING_SNAKE_CASE.
- Use ACTIVE direction only. Example: emit "User USES Neovim", never "Neovim USED_BY User".
- For past-tense / ended relations ("left", "was fired", "quit", "moved from"), set valid_from to the END date.
- confidence must be ≥ ${MIN_RELATION_CONFIDENCE}. Anything lower is dropped.
- Never use RELATED_TO. Prefer the most specific canonical type.

CANONICAL RELATIONS (use one of these; never invent inverses):
${canonicalRelationBlock()}

OUTPUT:
- Return STRICT JSON matching the provided schema. No prose, no markdown fences.
- For each memory, return its 0-based index alongside entities and relations.
- If a memory has no extractable entities, return entities: [] and relations: [] for that index.`;

export const GRAPH_EXTRACTION_SCHEMA = {
  name: 'graph_extraction',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['results'],
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['index', 'entities', 'relations'],
          properties: {
            index: { type: 'integer' },
            entities: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'entity_type'],
                properties: {
                  name: { type: 'string' },
                  entity_type: { type: 'string' },
                },
              },
            },
            relations: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: [
                  'subject',
                  'relation',
                  'object',
                  'confidence',
                  'valid_from',
                ],
                properties: {
                  subject: { type: 'string' },
                  relation: { type: 'string' },
                  object: { type: 'string' },
                  confidence: { type: 'number' },
                  valid_from: { type: ['string', 'null'] },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

export function buildGraphUserPrompt(memories: { content: string }[]): string {
  const lines = memories.map((m, i) => `[${i}] ${m.content}`).join('\n');
  return `<MEMORIES>\n${lines}\n</MEMORIES>\n\nExtract entities and relations from each memory above.`;
}
