// Shared AI integrations consumed by both `apps/ingestion` (embedder) and
// `apps/api` (embedder + reranker). Adapters are thin HTTP clients; each app
// wires a concrete instance from its own env secrets. Promoted here once
// retrieval landed and both workers needed them — see
// docs/retrieval_migration/decisions.md §3.
export * from './embeddings/index';
export * from './reranker/index';
