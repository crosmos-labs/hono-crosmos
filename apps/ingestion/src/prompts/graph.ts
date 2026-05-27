/**
 * Graph extraction (Pass 2) prompt + JSON schema. Mirrors
 * `app/engine/prompts/graph.py`.
 *
 * Pass 2 receives the **content strings** of the memories produced by Pass 1
 * and asks the LLM to extract entities + relations per memory. Graph failure
 * is non-fatal: the pipeline still persists memories without graph data (see
 * .codex/pipelines.md).
 */
import { RELATION_TYPES } from '../ontology/relation-types';

/**
 * Show each canonical relation once — skip inverses already covered by their
 * pair. Showing both directions (USES + USED_BY, OWNS + OWNED_BY) lets the
 * LLM pick either, fragmenting the graph. Inverses remain in the ontology
 * for retrieval rewrites; we just don't expose them as extraction targets.
 *
 * Mirrors Python's `_canonical_relations_block` (graph.py).
 */
function canonicalRelationBlock(): string {
  const shown = new Set<string>();
  const lines: string[] = [];
  for (const [name, defn] of Object.entries(RELATION_TYPES)) {
    if (shown.has(name)) continue;
    lines.push(`- ${name}: ${defn.description}`);
    shown.add(name);
    if (defn.inverse) shown.add(defn.inverse);
  }
  return lines.join('\n');
}

export const GRAPH_SYSTEM_PROMPT = `Given a list of extracted memories, identify the named entities and direct relationships in each memory.

## ENTITY NAMES
- Use consistent canonical forms. "User" or "user" → always use "User". Match the exact name from the memory text.
- Every entity that appears as a subject or object in a relation MUST be in the entities list of that same memory.

## ENTITIES
Extract ONLY proper nouns and widely recognized named entities. Each entity must be a concise name (max 5 words).

Entity types (use these exactly):
- person: Individuals, users, contacts. e.g. "Alice", "Dr. Patel", "User"
- organization: Companies, institutions, teams. e.g. "Google", "Stanford", "Zara"
- technology: Languages, frameworks, platforms, tools. e.g. "Python", "React", "AWS"
- project: Named systems, products, initiatives. e.g. "Crosmos", "CS 229"
- location: Physical or virtual places. e.g. "San Francisco", "Tokyo", "the office"
- object: Named physical items, devices, documents. e.g. "iPhone 15", "Bell Zephyr helmet"
- concept: Abstract named domains or skills. e.g. "machine learning", "UTI"

Do NOT extract as entities:
- Food orders, menu items: "Medium Cheesburst Margherita" → goes in content only
- Activities, verb phrases: "going for a walk", "eating dinner", "taking a vacation"
- Descriptions: "headphones that block out loud noise", "a pair of boots from Zara"
- Quantities, amounts, dates: "$185", "2 AM", "May 17"
- Generic nouns: "furniture", "side dishes", "assignment", "another assignment"
- Events/actions: "swimming", "playing piano", "5K", "marathon training"

GOOD: "Anthropic", "Sarah", "Boulder", "AWS", "iPhone 15", "Stanford"
BAD: "a pair of boots from Zara", "going for a walk", "eating dinner", "Medium Cheesburst Margherita with paneer topping"

The SUBJECTS and OBJECTS of an activity are entities — the activity itself is NOT. "I went to Japan" → entity: "Japan", NOT "trip to Japan".

## RELATIONS
For every memory with 2+ entities, determine whether the text expresses a direct relationship between any entity pair.

Direct relationships: action-object, ownership, usage, employment, preference, membership, travel, creation, communication, emotional stance, location, tool usage.

- Do NOT create relations from mere co-occurrence.
- Only connect pairs supported by the memory text.
- subject and object must match entity names exactly; subject != object. Every subject and object in a relation MUST appear in the entities list of that same memory.
- Prefer canonical type when it fits; otherwise use precise SCREAMING_SNAKE custom type.
- Never use RELATED_TO.
- Prioritize quality over quantity.
- Choose the most SPECIFIC relation type.
- Use the ACTIVE direction: "User USES Neovim", not "Neovim USED_BY User". The agent/owner is the subject.

Fields: subject, relation, object, confidence, valid_from

Confidence: higher for explicit relations, lower for inferred ones. Below 0.7 likely not a real relation.

valid_from = when the asserted fact about this relation became true.
Set valid_from only when memory gives an explicit transition date. Leave null for ongoing relations.

PAST TENSE / ENDED RELATIONS:
When memory says someone "left", "was fired", "quit", "moved from", the relation ENDED — set valid_from to the end date.

CANONICAL TYPES:
${canonicalRelationBlock()}

## EXAMPLES

Memories:
[0] User works at Anthropic as a research engineer on Claude safety.
[1] Emily got accepted to Stanford's MBA program on 2026-04-18.
[2] User left Anthropic in January 2026 to join OpenAI.

Output:
{"results":[{"index":0,"entities":[{"name":"User","entity_type":"person"},{"name":"Anthropic","entity_type":"organization"},{"name":"Claude","entity_type":"technology"}],"relations":[{"subject":"User","relation":"WORKS_FOR","object":"Anthropic","confidence":0.95,"valid_from":null}]},{"index":1,"entities":[{"name":"Emily","entity_type":"person"},{"name":"Stanford","entity_type":"organization"}],"relations":[{"subject":"Emily","relation":"ACCEPTED_TO","object":"Stanford","confidence":0.95,"valid_from":null}]},{"index":2,"entities":[{"name":"User","entity_type":"person"},{"name":"Anthropic","entity_type":"organization"},{"name":"OpenAI","entity_type":"organization"}],"relations":[{"subject":"User","relation":"WORKS_FOR","object":"Anthropic","confidence":0.95,"valid_from":"2026-01-01T00:00:00"},{"subject":"User","relation":"WORKS_FOR","object":"OpenAI","confidence":0.95,"valid_from":null}]}]}

## OUTPUT FORMAT
Return strict JSON. Each memory is identified by its 0-based index:
{"results":[{"index":0,"entities":[{"name":"...","entity_type":"..."}],"relations":[{"subject":"...","relation":"...","object":"...","confidence":0.0,"valid_from":"ISO8601"|null}]}]}

If a memory has no entities or relations, still include it with empty arrays.`;

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
