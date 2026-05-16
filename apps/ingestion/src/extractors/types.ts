/**
 * Shared types for raw LLM output and normalized pipeline facts.
 *
 * Naming: the *Raw* types match the wire JSON returned by the LLM. The
 * normalized counterparts use camelCase, dropped invalid values, parsed
 * datetimes (Date | null), and merged graph data per fact.
 */

export type MemoryTypeStr = 'semantic' | 'episode' | 'viewpoint';
export type SpeakerRole = 'user' | 'assistant' | 'system' | 'tool' | null;

// ----- Pass 1 (memories) -----

export interface RawExtractedMemory {
  content: string;
  memory_type: string;
  importance_score: number | null;
  speaker_role: string | null;
  event_time: string | null;
}

export interface RawExtractedMemories {
  memories: RawExtractedMemory[];
}

// ----- Pass 2 (graph) -----

export interface RawExtractedEntity {
  name: string;
  entity_type: string;
}

export interface RawExtractedRelation {
  subject: string;
  relation: string;
  object: string;
  confidence: number | null;
  valid_from: string | null;
}

export interface RawGraphResult {
  index: number;
  entities: RawExtractedEntity[];
  relations: RawExtractedRelation[];
}

export interface RawGraphExtraction {
  results: RawGraphResult[];
}

// ----- Normalized fact (post-Stage-5) -----

export interface NormalizedEntity {
  name: string;
  entityType: string;
}

export interface NormalizedRelation {
  subject: string;
  relation: string;
  object: string;
  confidence: number;
  validFrom: Date | null;
}

export interface NormalizedFact {
  content: string;
  memoryType: MemoryTypeStr;
  importanceScore: number;
  speakerRole: SpeakerRole;
  eventTime: Date | null;
  entities: NormalizedEntity[];
  relations: NormalizedRelation[];
}
