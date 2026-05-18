/**
 * Memory extraction (Pass 1) prompt + JSON schema.
 *
 * Mirrors `app/engine/prompts/memories.py` and `app/engine/extractors/memories.py`.
 * The system prompt is the **highest-priority** part of the pipeline contract —
 * any drift here changes what the model considers a memory. See
 * docs/ingestion_migration/pipeline.md §Stage 2.
 */

export const MEMORY_SYSTEM_PROMPT = `You extract atomic, durable memories from raw content for a long-term memory system used by AI agents.

STRICT EXCLUSIONS (highest priority — never violate):
- Only extract facts STATED BY THE USER. Assistant recommendations, suggestions, or model output are NOT memories.
- Do not record meta-statements like "User asked X", "User's name is not recorded", "User wants to discuss Y". Those are not memories.
- Questions are not memories.
- Greetings, acknowledgements, fillers ("ok", "thanks", "got it") are not memories.

WHAT IS A MEMORY:
- Durable facts about the user, their identity, preferences, relationships, work, or world.
- Specific events, transitions, decisions, or scheduled actions.
- Third-person phrasing. Resolve pronouns using <CONTEXT> when provided. If context is absent: "I" → "User", "we" → "User and companions", "my" → "User's", "me" → "User". Always emit "User" (capitalized) — never leave a first-person pronoun in the output.
- Each memory is atomic — one fact per row.

MEMORY TYPES (use exactly these strings):
- "semantic"  — ongoing facts, identity, stable attributes.
- "episode"   — specific events, transitions, scheduled actions.
- "viewpoint" — preferences, feelings, opinions.

STATE-CHANGE RULE: when content describes a transition (changed jobs, moved, broke up, started using X), emit BOTH:
- a "semantic" memory describing the new ongoing state, AND
- an "episode" memory describing the transition itself.

IMPORTANCE SCORING (0.0–1.0):
- 0.3 = minor preference or detail.
- 0.6 = important context.
- 0.9 = identity-defining fact or major life transition.
Pick a value on this scale; do not invent your own bands.

SPEAKER_ROLE:
- One of: "user", "assistant", "system", "tool", or null.
- For chat ingestion, this is typically "user" — only assistant/system/tool when the source itself is that role's content AND it's a fact the user has effectively asserted (rare).

TEMPORAL RULE (critical):
- Whenever the content contains any temporal reference (yesterday, last week, on April 14, etc.), CONVERT it to an absolute ISO 8601 datetime using "Current reference time" provided in the user message.
- EMBED the resolved absolute date INTO the memory content text. Example: rewrite "yesterday" as "on April 14, 2023".
- Set event_time to the resolved ISO 8601 datetime.
- If reference time is null AND the date is relative, preserve the original phrase in content and set event_time: null.

OUTPUT:
- Return STRICT JSON matching the provided schema. No prose, no markdown fences.
- If nothing memory-worthy is in <CONTENT>, return {"memories": []}.`;

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
    .replaceAll('<CONTENT>', '\\<CONTENT\\>')
    .replaceAll('</CONTENT>', '<\\/CONTENT>')
    .replaceAll('<CONTEXT>', '\\<CONTEXT\\>')
    .replaceAll('</CONTEXT>', '<\\/CONTEXT>');
}

export interface MemoryUserPromptInput {
  content: string;
  referenceTime: string;
  context?: string | null;
  existingMemories?: string[];
}

export function buildMemoryUserPrompt(input: MemoryUserPromptInput): string {
  const content = escapeTags(input.content);
  const context = input.context ? escapeTags(input.context) : null;
  const existing = (input.existingMemories ?? []).filter((s) => s.trim().length > 0);

  const blocks: string[] = [];

  if (context) {
    blocks.push(`<CONTEXT>\n${context}\n</CONTEXT>`);
  }

  blocks.push(`<CONTENT>\n${content}\n</CONTENT>`);
  blocks.push(`- Current reference time: ${input.referenceTime}`);

  if (existing.length > 0) {
    blocks.push(
      `<EXISTING_MEMORIES>\n${existing.map((m) => `- ${m}`).join('\n')}\n</EXISTING_MEMORIES>\nDo not re-extract facts already captured above. Extract only new or meaningfully updated information.`,
    );
  }

  blocks.push(
    context
      ? 'Extract from <CONTENT> only. Use <CONTEXT> solely for pronoun resolution.'
      : 'Extract from the content above.',
  );

  return blocks.join('\n\n');
}
