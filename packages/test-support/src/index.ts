/**
 * Shared test-only helpers. Not imported by any production code path.
 *
 * Lives in its own package because both Workers need it: the API tests prove
 * retrieval equivalence and the ingestion tests prove pipeline behaviour, and
 * both need the same real-Postgres fixture harness. Duplicating it drifts;
 * reaching across `apps/*` boundaries couples the two Workers.
 */
export * from './test-db';
