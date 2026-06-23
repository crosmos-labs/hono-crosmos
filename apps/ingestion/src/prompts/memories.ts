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
- The assistant's GENERIC knowledge or broad explanations not specific to this user: definitions, how things work in general, encyclopedic facts. "Blockchain is a decentralized ledger" → skip.

If the content contains no extractable fact — neither a user statement nor a specific assistant-provided fact (defined in RULES 1–2) — return {"memories":[]}.

## RULES
1. Extract two kinds of facts:
   (a) Facts STATED BY THE USER, regardless of subject. "Rachit eats pizza" → extract.
   (b) SPECIFIC, user-relevant facts the ASSISTANT provides in direct response to the user: computed results/totals, concrete recommendations the assistant commits to FOR THIS USER, and specific answers (numbers, names, dates, prices, settings, step-by-step instructions). "For your 4-person trip the total is $2,340" → extract. "I'd go with the Patagonia Torrentshell for your rainy hikes" → extract. Do NOT extract the assistant's generic world knowledge, definitions, or broad multi-option surveys where it did not commit to a specific answer for the user. "Acadia is generally good for families" → skip; "Based on your toddler and budget I recommend Acadia" → extract.
2. Each memory must be a direct factual statement phrased STANDALONE — capture the value/name/recommendation itself, NOT "the assistant said ..." or "the user was told ...". Do NOT summarize the conversation or extract conversational actions.
3. Third person. Resolve pronouns using context. If context is absent: "I" → USER, "we" → USER and companions, "my" → USER's.
4. Set speaker_role to "user" for facts the user stated, and "assistant" for specific facts the assistant provided.
5. Separate topics into separate memories (work, preferences, events).
6. Do not atomize — keep related facts together, but preserve EVERY specific name and detail verbatim within the combined memory.
7. Skip greetings, filler, procedural chatter.
8. Deduplication: exact semantic overlap with existing_memories → skip. Same fact with NEW dates/details → extract. Same topic, different context → extract.
9. Preserve ALL specific names verbatim: brands, stores, venues, products, people, quantities, amounts, destinations, locations. NEVER drop or generalize.
10. Preferences are TWO-SIDED. When the user expresses a preference, extract BOTH what they LIKE and what they DISLIKE / AVOID / want to move away from — each WITH its specific details AND the stated reason. "I'm avoiding screens before bed because it hurts my sleep" → extract the avoidance (no phone/TV in the evening) AND the reason (hurts sleep), not just "winds down at 9:30pm". When the user wants to branch from X to Y ("tired of true crime, want to try history"), capture BOTH the rejected X and the desired Y. A dislike/constraint is as important as a like — never drop it.

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

## ASSISTANT CONTENT — KEEP vs SKIP
The line is SPECIFIC-TO-THIS-USER vs GENERIC. Keep the assistant's specific answers; skip its generic teaching.
- SKIP generic knowledge / definitions: "Blockchain provides decentralization..." , "CAAT refers to the use of technology..." → SKIP
- SKIP broad multi-option surveys with no commitment: "Madewell and Kate Spade are both known for quality" → SKIP
- SKIP absence of information: "User's name is not recorded" → SKIP
- KEEP a specific value the assistant computed/looked up for the user: "Your monthly payment works out to $487" → EXTRACT (speaker_role=assistant)
- KEEP a concrete recommendation the assistant commits to for the user: "For your toddler-friendly trip I recommend Acadia National Park" → EXTRACT (speaker_role=assistant)
- KEEP specific instructions/settings the assistant gave: "Bake your sourdough at 450°F for 30 minutes" → EXTRACT (speaker_role=assistant)
- KEEP a specific fact, answer, or item the assistant provided in response to the user that the user may later refer back to — a named entity, a count, a measurement, a quote, or a specific item from a list: "The study you asked about included 38 participants", "The hostel near the Red Light District is the International Budget Hostel", "The traditional powwow game is the Hoop Dance" → EXTRACT (speaker_role=assistant). Still SKIP generic textbook knowledge not tied to the user's request.
- KEEP user accepting/deciding: "I'll go with the ocean view room" → EXTRACT (speaker_role=user)
- KEEP user revealing intent: "I'm thinking of organizing my closet this weekend" → EXTRACT (speaker_role=user)
- KEEP user stating a fact about themselves: "I've been making my bed every morning for two weeks" → EXTRACT (speaker_role=user)
- KEEP a user DISLIKE / avoidance / constraint WITH its reason: "I've been avoiding TV and my phone in the evenings because the screen time has been hurting my sleep" → EXTRACT the avoidance AND the reason (speaker_role=user)
- KEEP a user changing direction — capture BOTH sides: "I'm getting tired of true crime podcasts and want to try history ones" → EXTRACT the rejected genre AND the desired genre (speaker_role=user)

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

Input (assistant turn): "I added up your flights, hotel, and rental car — your Tokyo trip comes to $4,820 total." with reference_time 2026-04-18
{"memories":[{"content":"The total cost of the user's Tokyo trip (flights, hotel, rental car) is $4,820.","memory_type":"semantic","importance_score":0.6,"speaker_role":"assistant","event_time":null}]}

Input (assistant turn): "Blockchain is a decentralized ledger maintained across many nodes."
{"memories":[]}

Input (assistant turn): "The binaural-beats study you asked about included 38 participants over an 8-week period."
{"memories":[{"content":"The binaural beats study the user asked about included 38 participants over an 8-week period.","memory_type":"semantic","importance_score":0.3,"speaker_role":"assistant","event_time":null}]}

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
