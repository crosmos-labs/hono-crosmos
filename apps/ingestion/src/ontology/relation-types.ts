/**
 * Relation ontology. Mirrors `app/engine/ontology/relation_types.py`.
 *
 * The graph extraction prompt only advertises **one side** of each inverse
 * pair to the LLM (to prevent it from fragmenting the graph by emitting both
 * `WORKS_FOR` and `EMPLOYS`). Inverses remain in the registry purely for
 * retrieval-time query rewriting.
 *
 * See docs/ingestion_migration/entity-resolution.md §Relation ontology.
 */
export interface RelationTypeMeta {
  description: string;
  /** Inverse relation name, or `null` if symmetric / no inverse. */
  inverse: string | null;
  category:
    | 'professional'
    | 'preference'
    | 'usage'
    | 'social'
    | 'location'
    | 'ownership'
    | 'structure'
    | 'activity'
    | 'transaction';
}

export const RELATION_TYPES: Readonly<Record<string, RelationTypeMeta>> = {
  WORKS_FOR: { description: 'Employment or affiliation relationship', inverse: 'EMPLOYS', category: 'professional' },
  EMPLOYS: { description: 'Inverse of WORKS_FOR', inverse: 'WORKS_FOR', category: 'professional' },
  PREFERS: { description: 'Neutral preference or choice', inverse: null, category: 'preference' },
  LIKES: { description: 'Positive preference, enjoyment, or enthusiasm', inverse: null, category: 'preference' },
  DISLIKES: { description: 'Negative preference, aversion, or dislike', inverse: null, category: 'preference' },
  USES: { description: 'Usage relationship (tool, technology, resource)', inverse: 'USED_BY', category: 'usage' },
  USED_BY: { description: 'Inverse of USES', inverse: 'USES', category: 'usage' },
  KNOWS: { description: 'Acquaintance or familiarity with a person', inverse: null, category: 'social' },
  FRIEND_OF: { description: 'Friendship relationship between people', inverse: null, category: 'social' },
  PARTNER_OF: { description: 'Romantic partner, spouse, girlfriend, boyfriend', inverse: null, category: 'social' },
  MANAGES: { description: 'Management or supervisory relationship', inverse: 'MANAGED_BY', category: 'professional' },
  MANAGED_BY: { description: 'Inverse of MANAGES', inverse: 'MANAGES', category: 'professional' },
  LOCATED_IN: { description: 'Physical or virtual location', inverse: 'CONTAINS', category: 'location' },
  CONTAINS: { description: 'Inverse of LOCATED_IN', inverse: 'LOCATED_IN', category: 'location' },
  OWNS: { description: 'Ownership or possession', inverse: 'OWNED_BY', category: 'ownership' },
  OWNED_BY: { description: 'Inverse of OWNS', inverse: 'OWNS', category: 'ownership' },
  PART_OF: { description: 'Component or membership relationship', inverse: 'HAS_PART', category: 'structure' },
  HAS_PART: { description: 'Inverse of PART_OF', inverse: 'PART_OF', category: 'structure' },
  ATTENDED: { description: 'Attended an event, concert, class, or gathering', inverse: null, category: 'activity' },
  VISITED: { description: 'Visited a place or location', inverse: null, category: 'activity' },
  PURCHASED: { description: 'Bought or acquired something', inverse: null, category: 'transaction' },
  COST: { description: 'Monetary cost or price of something', inverse: null, category: 'transaction' },
  PLANNED: { description: 'Planned or intended to do something', inverse: null, category: 'activity' },
  TRAVELED_TO: { description: 'Traveled to a destination', inverse: null, category: 'activity' },
  RECOMMENDS: { description: 'Recommends or suggests something', inverse: null, category: 'preference' },
  EXPERIENCED: { description: 'Had an experience or went through something', inverse: null, category: 'activity' },
  MET: { description: 'Met or encountered a person', inverse: null, category: 'social' },
  WITH: { description: 'Accompanied by or together with someone', inverse: null, category: 'social' },
} as const;

/**
 * Canonical relations exposed to the LLM. For every inverse pair we expose
 * only one side (the "active" direction) so the LLM doesn't fragment the
 * graph by choosing direction. Matches Python's `_canonical_relations_block`.
 *
 * Suppressed inverses: USED_BY, OWNED_BY, EMPLOYS, MANAGED_BY, HAS_PART, CONTAINS.
 */
const SUPPRESSED_INVERSES = new Set([
  'USED_BY',
  'OWNED_BY',
  'EMPLOYS',
  'MANAGED_BY',
  'HAS_PART',
  'CONTAINS',
]);

export const CANONICAL_RELATIONS: readonly string[] = Object.keys(
  RELATION_TYPES,
).filter((name) => !SUPPRESSED_INVERSES.has(name));
