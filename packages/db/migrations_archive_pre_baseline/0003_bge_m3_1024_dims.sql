-- Switch embeddings from OpenAI text-embedding-3-small (1536) to Cloudflare
-- Workers AI @cf/baai/bge-m3 (1024). Vectors across models are not comparable,
-- so existing embeddings are discarded (dev data is disposable; re-ingest to
-- repopulate). pgvector cannot ALTER a column's dimension while an HNSW index
-- references it, so we drop the indexes, recreate the columns at 1024, and
-- rebuild the indexes.
DROP INDEX IF EXISTS "memories_embedding_hnsw_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "entities_embedding_hnsw_idx";--> statement-breakpoint

ALTER TABLE "memories" DROP COLUMN IF EXISTS "embedding";--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "embedding" vector(1024);--> statement-breakpoint
ALTER TABLE "entities" DROP COLUMN IF EXISTS "embedding";--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "embedding" vector(1024);--> statement-breakpoint

CREATE INDEX "memories_embedding_hnsw_idx" ON "memories" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "entities_embedding_hnsw_idx" ON "entities" USING hnsw ("embedding" vector_cosine_ops);
