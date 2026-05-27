/**
 * Memory extraction (Pass 1) prompt + JSON schema.
 *
 * Mirrors `app/engine/prompts/memories.py` and `app/engine/extractors/memories.py`.
 * The system prompt is the **highest-priority** part of the pipeline contract —
 * any drift here changes what the model considers a memory. See
 * .codex/pipelines.md.
 */

export const MEMORY_SYSTEM_PROMPT = `Extract contextual memories from content. A memory must be useful for future personalization or task continuation.

## STRICT EXCLUSIONS (HIGHEST PRIORITY)

NEVER extract:
- Conversation descriptions: "User asked...", "Assistant responded...", "User was told..."
- Assistant actions: "I'll save this", "I've added it", "I will remember this"
- Any description of the interaction itself
- Absence of information: "User's name is not known", "not recorded", "no information available"
- Questions the user asked (only extract what the user STATED, not asked)

If the content does not contain a direct factual statement from the USER, return {"memories":[]}.

## RULES
1. Only extract facts stated by the USER, regardless of subject. "Rachit eats pizza" → extract. Do NOT extract what the ASSISTANT says — advice, recommendations, explanations, tips, world knowledge, product comparisons. "Blockchain is a decentralized ledger" → skip. "User is advised to organize their closet" → skip. "Acadia National Park is recommended for families" → skip.
2. Each memory must be a direct factual statement. Do NOT summarize the conversation, do NOT extract assistant responses or actions.
3. Third person. Resolve pronouns using context. If context is absent: "I" → USER, "we" → USER and companions, "my" → USER's.
4. Separate topics into separate memories (work, preferences, events).
5. Do not atomize — keep related facts together, but preserve EVERY specific name and detail verbatim within the combined memory.
6. Skip greetings, filler, procedural chatter.
7. Deduplication: exact semantic overlap with existing_memories → skip. Same fact with NEW dates/details → extract. Same topic, different context → extract.
8. Preserve ALL specific names verbatim: brands, stores, venues, products, people, quantities, amounts, destinations, locations. NEVER drop or generalize.
9. When user expresses preferences about a specific thing (hotel features, activity types, cuisine), extract the preference WITH the specific details — NOT a vague summary.

## STATE CHANGES
If text implies a new current state, emit BOTH:
- semantic memory for current state
- episode memory for transition

## MEMORY TYPES
- semantic: ongoing states, identity, durable facts
- episode: events, transitions, scheduled actions
- viewpoint: preferences, feelings, opinions

## SCORING
0.3 = minor preference or detail: "User likes ramen"
0.6 = important context: "User works as a software engineer"
0.9 = identity-defining or major transition: "User started a PhD", "User moved to Boulder"

## TEMPORAL
- ALWAYS extract event_time when ANY temporal reference exists (dates, "last Saturday", "three weeks ago", "yesterday").
- Convert relative dates to absolute ISO8601 using reference_time.
- Embed resolved absolute date INTO content text (replace "yesterday" with "on April 14, 2023").
- If reference_time is null and date is relative, preserve the original phrase and set event_time to null.
- null for ongoing facts without a specific date.

## ASSISTANT CONTENT FILTER
- Assistant recommendations are NOT memories: "User is advised to..." → SKIP
- Generic knowledge is NOT a memory: "Blockchain provides decentralization..." → SKIP
- Product/brand comparisons by assistant are NOT memories: "Madewell and Kate Spade are known for..." → SKIP
- Assistant explaining concepts is NOT a memory: "CAAT refers to the use of technology..." → SKIP
- Absence of information is NOT a memory: "User's name is not recorded" → SKIP
- User accepting/deciding IS a memory: "I'll go with the ocean view room" → EXTRACT
- User revealing intent IS a memory: "I'm thinking of organizing my closet this weekend" → EXTRACT
- User stating a fact about themselves IS a memory: "I've been making my bed every morning for two weeks" → EXTRACT

## NEGATIVE EXAMPLES

Input: "What's my name?"
{"memories":[]}

Input: "Do you know my name?"
{"memories":[]}

Input: "I'll save that for you."
{"memories":[]}

Input: "User asked what their name is."
{"memories":[]}

Input: "My name is not recorded anywhere in this system."
{"memories":[]}

## POSITIVE EXAMPLES (boundary cases — these ARE memories)

Input: "I'm thinking of organizing my closet this weekend." with reference_time 2026-04-18
{"memories":[{"content":"User plans to organize their closet on 2026-04-18.","memory_type":"episode","importance_score":0.3,"event_time":"2026-04-18T00:00:00"}]}

Input: "I've been doing yoga every morning for 3 months."
{"memories":[{"content":"User has been doing yoga every morning for 3 months.","memory_type":"semantic","importance_score":0.6,"event_time":null}]}

Input: "Sounds good, I'll go with the ocean view room." with reference_time 2026-04-18
{"memories":[{"content":"User chose the ocean view room.","memory_type":"episode","importance_score":0.3,"event_time":"2026-04-18T00:00:00"}]}

Input: "I just moved from San Francisco to Boulder." with reference_time 2026-04-18
{"memories":[{"content":"User lives in Boulder.","memory_type":"semantic","importance_score":0.9,"event_time":null},{"content":"User moved from San Francisco to Boulder on 2026-04-18.","memory_type":"episode","importance_score":0.9,"event_time":"2026-04-18T00:00:00"}]}

## PITFALLS
- Do NOT atomize rich facts into thin fragments.
- Relative dates in content MUST be replaced with absolute dates.
- Bare years ("in 2022"), seasons ("last fall", "summer 2025"), and decade markers ALWAYS imply a concrete event_time.
- Coreferences: always resolve to the specific name.

## OUTPUT FORMAT
Return strict JSON:
{"memories":[{"content":"...","memory_type":"semantic|episode|viewpoint","importance_score":0.0,"speaker_role":"user|assistant|system|tool"|null,"event_time":"ISO8601"|null}]}

If no memories: {"memories":[]}`;

/**
 * JSON Schema for the extraction response. Designed to satisfy OpenAI / OpenRouter
 * strict-mode constraints: every property listed in \`required\`, every object
 * has \`additionalProperties: false\`, no top-level union.
 */
export const MEMORY_EXTRACTION_SCHEMA = {
  name: 'extracted_memories',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['memories'],
    properties: {
      memories: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'content',
            'memory_type',
            'importance_score',
            'speaker_role',
            'event_time',
          ],
          properties: {
            content: { type: 'string' },
            memory_type: {
              type: 'string',
              enum: ['semantic', 'episode', 'viewpoint'],
            },
            importance_score: { type: 'number' },
            speaker_role: {
              type: ['string', 'null'],
              enum: ['user', 'assistant', 'system', 'tool', null],
            },
            event_time: { type: ['string', 'null'] },
          },
        },
      },
    },
  },
} as const;

/**
 * Escape `<CONTENT>` / `<CONTEXT>` substrings in user-supplied text so a
 * malicious source cannot close our tags and inject extra instructions.
 * Matches Python's mitigation in `extractors/memories.py`.
 */
function escapeTags(s: string): string {
  return s
    .replaceAll('</CONTENT>', '<\\/CONTENT>')
    .replaceAll('<CONTENT>', '\\<CONTENT\\>')
    .replaceAll('</CONTEXT>', '<\\/CONTEXT>')
    .replaceAll('<CONTEXT>', '\\<CONTEXT\\>');
}

export interface MemoryUserPromptInput {
  content: string;
  /** ISO-8601 reference time, or null for content without a temporal anchor. */
  referenceTime: string | null;
  context?: string | null;
  existingMemories?: string[];
}

export function buildMemoryUserPrompt(input: MemoryUserPromptInput): string {
  const safeContent = escapeTags(input.content);
  const safeContext = input.context ? escapeTags(input.context) : null;

  const referenceTimeStr = input.referenceTime
    ? `\n- Current reference time: ${input.referenceTime}`
    : '';

  let existingMemoriesStr = '';
  const existing = (input.existingMemories ?? []).filter((s) => s.trim().length > 0);
  if (existing.length > 0) {
    const items = existing.map((m) => `- ${m}`).join('\n');
    existingMemoriesStr =
      `\n\n<EXISTING_MEMORIES>\n${items}\n</EXISTING_MEMORIES>\n` +
      'Do not re-extract facts already captured above. ' +
      'Extract only new or meaningfully updated information.';
  }

  if (safeContext) {
    return (
      `<CONTEXT>\n${safeContext}\n</CONTEXT>\n\n` +
      `<CONTENT>\n${safeContent}\n</CONTENT>` +
      `${referenceTimeStr}${existingMemoriesStr}\n\n` +
      'Extract from <CONTENT> only. Use <CONTEXT> solely for pronoun resolution.'
    );
  }
  return (
    `<CONTENT>\n${safeContent}\n</CONTENT>` +
    `${referenceTimeStr}${existingMemoriesStr}\n\n` +
    'Extract from the content above.'
  );
}
