/**
 * Entity ontology. Mirrors `app/engine/ontology/entity_types.py`.
 *
 * The DB column is `text` (not an enum) so older/extended types do not break
 * inserts; validation happens here at the engine layer. Anything not in this
 * list is allowed but coerced to `DEFAULT_ENTITY_TYPE` when backfilled from a
 * relation that didn't supply a type.
 *
 * See .codex/pipelines.md.
 */
export interface EntityTypeMeta {
  description: string;
  examples: readonly string[];
}

export const ENTITY_TYPES: Readonly<Record<string, EntityTypeMeta>> = {
  person: {
    description: 'Individuals, users, contacts, people mentioned in conversation',
    examples: ['Alice', 'Bob', 'the user', 'my manager'],
  },
  organization: {
    description: 'Companies, teams, institutions, groups, departments',
    examples: ['Google', 'the team', 'engineering department', 'startup'],
  },
  technology: {
    description: 'Programming languages, frameworks, libraries, platforms, tools, and software services',
    examples: ['Python', 'PostgreSQL', 'React', 'AWS', 'Docker', 'ARQ'],
  },
  project: {
    description: 'Named systems, products, codebases, or initiatives being built or worked on',
    examples: ['Crosmos', 'the API', 'Consolidation Engine', 'the mobile app'],
  },
  concept: {
    description: 'Abstract ideas, domains, skills, preferences, and principles — not tools or named projects',
    examples: ['machine learning', 'dark mode preference', 'work-life balance', 'honesty'],
  },
  location: {
    description: 'Physical or virtual places, cities, regions, addresses',
    examples: ['San Francisco', 'the office', 'remote', 'AWS us-east-1'],
  },
  object: {
    description: 'Physical items, devices, possessions, and documents',
    examples: ['laptop', 'iPhone', 'the server', 'the README'],
  },
} as const;

export const ENTITY_TYPE_NAMES = Object.keys(ENTITY_TYPES) as readonly string[];

export function isKnownEntityType(t: string): boolean {
  return Object.prototype.hasOwnProperty.call(ENTITY_TYPES, t);
}
