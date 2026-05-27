/**
 * Normalization + dedup. Mirrors `app/engine/extractors/normalize.py` and the
 * normalization pass in `app/engine/extractors/memories.py`.
 *
 * Order matters; see .codex/pipelines.md. Each drop reason is counted in a
 * `DropCounter` so the pipeline can log a summary.
 */
import {
  DEFAULT_ENTITY_TYPE,
  ENTITY_NAME_MAX_WORDS,
  MIN_IMPORTANCE_SCORE,
  MIN_RELATION_CONFIDENCE,
} from '../constants';
import type {
  MemoryTypeStr,
  NormalizedEntity,
  NormalizedFact,
  NormalizedRelation,
  RawExtractedEntity,
  RawExtractedMemory,
  RawExtractedRelation,
  RawGraphResult,
  SpeakerRole,
} from './types';

const VALID_MEMORY_TYPES: ReadonlySet<MemoryTypeStr> = new Set([
  'semantic',
  'episode',
  'viewpoint',
]);

const VALID_SPEAKER_ROLES: ReadonlySet<string> = new Set([
  'user',
  'assistant',
  'system',
  'tool',
]);

/**
 * Generic low-signal patterns. Mirrors Python's `GENERIC_CONTENT_PATTERNS`
 * verbatim. Anchored with `^` / `$` to catch whole-message junk only.
 */
const GENERIC_CONTENT_PATTERNS: RegExp[] = [
  /^\s*(okay|ok|thanks|thank you|sure|sounds good|got it)\s*\.?$/i,
  /^\s*user\s+(asked|said|mentioned)\s+that\s*$/i,
];

export class DropCounter {
  private readonly counts = new Map<string, number>();

  bump(reason: string): void {
    this.counts.set(reason, (this.counts.get(reason) ?? 0) + 1);
  }

  summary(): Record<string, number> {
    return Object.fromEntries(this.counts.entries());
  }
}

function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Uppercase + underscore-collapse — `users-uses` → `USERS_USES`. */
export function normalizeRelationName(s: string): string {
  return s
    .trim()
    .replace(/-/g, '_')
    .split(/\s+/)
    .filter((p) => p.length > 0)
    .join('_')
    .toUpperCase()
    .replace(/_+/g, '_');
}

function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Mirrors Python's `normalize_score`. Returns the score if it is a finite
 * number in [0, 1], otherwise null.
 */
function normalizeScore(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0 || value > 1) return null;
  return value;
}

function wordCount(s: string): number {
  const t = s.trim();
  if (t.length === 0) return 0;
  return t.split(/\s+/).length;
}

/**
 * Per-entity normalization: drops empty names and within-fact dups
 * (case-insensitive on the trimmed name).
 */
function normalizeEntities(
  raw: RawExtractedEntity[] | undefined,
  drops: DropCounter,
): NormalizedEntity[] {
  if (!raw || raw.length === 0) return [];
  const out: NormalizedEntity[] = [];
  const seen = new Set<string>();
  for (const e of raw) {
    const name = normalizeText(e.name ?? '');
    if (name.length === 0) {
      drops.bump('empty_entity_name');
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      drops.bump('duplicate_entity');
      continue;
    }
    seen.add(key);
    const entityType =
      typeof e.entity_type === 'string' && e.entity_type.trim().length > 0
        ? e.entity_type.trim()
        : DEFAULT_ENTITY_TYPE;
    out.push({ name, entityType });
  }
  return out;
}

/**
 * Per-relation normalization: drops empty/low-confidence/self-relations,
 * canonicalizes the relation name, fills `valid_from` from `event_time` if
 * the LLM didn't supply one.
 */
function normalizeRelation(
  raw: RawExtractedRelation,
  factEventTime: Date | null,
  drops: DropCounter,
): NormalizedRelation | null {
  const subject = normalizeText(raw.subject ?? '');
  const object = normalizeText(raw.object ?? '');
  const relation = normalizeRelationName(raw.relation ?? '');

  if (relation.length === 0) {
    drops.bump('empty_relation_name');
    return null;
  }
  if (subject.length === 0 || object.length === 0) {
    drops.bump('empty_relation_subject_or_object');
    return null;
  }
  if (subject.toLowerCase() === object.toLowerCase()) {
    drops.bump('self_relation');
    return null;
  }
  const confidence = normalizeScore(raw.confidence);
  if (confidence === null || confidence < MIN_RELATION_CONFIDENCE) {
    drops.bump('low_confidence_relation');
    return null;
  }
  const validFrom = parseIsoDate(raw.valid_from) ?? factEventTime;
  return { subject, relation, object, confidence, validFrom };
}

/**
 * Per-fact normalization. Returns null if the fact should be dropped.
 * Backfills entity stubs for any name only mentioned in a relation.
 */
function normalizeFact(
  raw: RawExtractedMemory,
  graph: RawGraphResult | null,
  drops: DropCounter,
): NormalizedFact | null {
  const content = normalizeText(raw.content ?? '');
  if (content.length === 0) {
    drops.bump('low_signal_content');
    return null;
  }
  if (wordCount(content) < 4) {
    drops.bump('low_signal_content');
    return null;
  }
  if (GENERIC_CONTENT_PATTERNS.some((re) => re.test(content))) {
    drops.bump('low_signal_content');
    return null;
  }

  const memoryType = raw.memory_type as MemoryTypeStr | undefined;
  if (!memoryType || !VALID_MEMORY_TYPES.has(memoryType)) {
    drops.bump('invalid_memory_type');
    return null;
  }

  let speakerRole: SpeakerRole = null;
  if (raw.speaker_role !== null && raw.speaker_role !== undefined) {
    if (!VALID_SPEAKER_ROLES.has(raw.speaker_role)) {
      drops.bump('invalid_speaker_role');
      return null;
    }
    speakerRole = raw.speaker_role as SpeakerRole;
  }

  const importanceScore = normalizeScore(raw.importance_score);
  if (importanceScore === null || importanceScore < MIN_IMPORTANCE_SCORE) {
    drops.bump('low_importance_score');
    return null;
  }

  const eventTime = parseIsoDate(raw.event_time);

  // Entities + relations from graph (may be absent if graph extraction failed)
  const entities = normalizeEntities(graph?.entities, drops);
  const relations: NormalizedRelation[] = [];
  for (const r of graph?.relations ?? []) {
    const norm = normalizeRelation(r, eventTime, drops);
    if (norm) relations.push(norm);
  }

  // Backfill entities mentioned only in relations (entity_type = "object")
  const knownNames = new Set(entities.map((e) => e.name.toLowerCase()));
  for (const rel of relations) {
    for (const name of [rel.subject, rel.object]) {
      const key = name.toLowerCase();
      if (knownNames.has(key)) continue;
      if (wordCount(name) > ENTITY_NAME_MAX_WORDS) continue;
      entities.push({ name, entityType: DEFAULT_ENTITY_TYPE });
      knownNames.add(key);
      drops.bump('entity_added_from_relation');
    }
  }

  return {
    content,
    memoryType,
    importanceScore,
    speakerRole,
    eventTime,
    entities,
    relations,
  };
}

/**
 * Drive normalization across all Pass-1 memories, joining each with its
 * Pass-2 graph result by index. Drops duplicates by
 * `(content.casefold(), memory_type, speaker_role, event_time.isoformat())`.
 */
export function normalizeFacts(
  rawMemories: RawExtractedMemory[],
  graphResults: RawGraphResult[],
  drops: DropCounter,
): NormalizedFact[] {
  const graphByIndex = new Map<number, RawGraphResult>();
  for (const g of graphResults) graphByIndex.set(g.index, g);

  const out: NormalizedFact[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < rawMemories.length; i++) {
    const raw = rawMemories[i]!;
    const norm = normalizeFact(raw, graphByIndex.get(i) ?? null, drops);
    if (!norm) continue;

    const key = [
      norm.content.toLowerCase(),
      norm.memoryType,
      norm.speakerRole ?? '',
      norm.eventTime ? norm.eventTime.toISOString() : '',
    ].join('|');
    if (seen.has(key)) {
      drops.bump('duplicate_fact');
      continue;
    }
    seen.add(key);
    out.push(norm);
  }

  return out;
}
