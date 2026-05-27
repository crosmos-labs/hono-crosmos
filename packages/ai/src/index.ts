// Shared AI integrations consumed by both `apps/ingestion` (embedder) and
// `apps/api` (embedder + reranker). Adapters are thin HTTP clients; each app
// wires a concrete instance from its own env secrets.
export * from './embeddings/index';
export * from './reranker/index';
