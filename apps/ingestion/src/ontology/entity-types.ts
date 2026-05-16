/**
 * Entity ontology. Mirrors `app/engine/ontology/entity_types.py`.
 *
 * The DB column is `text` (not an enum) so older/extended types do not break
 * inserts; validation happens here at the engine layer. Anything not in this
 * list is allowed but coerced to `DEFAULT_ENTITY_TYPE` when backfilled from a
 * relation that didn't supply a type.
 *
 * See docs/ingestion_migration/entity-resolution.md §Entity ontology.
 */
export interface EntityTypeMeta {
  description: string;
  examples: readonly string[];
}

export const ENTITY_TYPES: Readonly<Record<string, EntityTypeMeta>> = {
  person: {
    description: 'Individuals, users, contacts',
    examples: ['Alice', 'Dr. Patel', 'User'],
  },
  organization: {
    description: 'Companies, institutions, teams',
    examples: ['Google', 'Stanford', 'Zara'],
  },
  technology: {
    description: 'Languages, frameworks, platforms, tools',
    examples: ['Python', 'React', 'AWS', 'Docker'],
  },
  project: {
    description: 'Named systems / products / initiatives',
    examples: ['Crosmos', 'CS 229'],
  },
  concept: {
    description: 'Abstract named domains or skills',
    examples: ['machine learning', 'UTI', 'work-life balance'],
  },
  location: {
    description: 'Physical or virtual places',
    examples: ['San Francisco', 'Tokyo', 'the office'],
  },
  object: {
    description: 'Named physical items, devices, docs',
    examples: ['iPhone 15', 'Bell Zephyr helmet'],
  },
} as const;

export const ENTITY_TYPE_NAMES = Object.keys(ENTITY_TYPES) as readonly string[];

export function isKnownEntityType(t: string): boolean {
  return Object.prototype.hasOwnProperty.call(ENTITY_TYPES, t);
}
