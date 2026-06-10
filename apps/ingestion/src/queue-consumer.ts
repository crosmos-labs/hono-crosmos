import type { Database } from '@crosmos/db';
import type { Logger } from '@crosmos/observability';
import type { QueueDelivery } from '@crosmos/runtime';
import type { IngestionJobMessage } from '@crosmos/types';
import type { VectorStore } from '@crosmos/vector';
import type { Embedder } from './integrations/embeddings';
import type { LLM } from './integrations/llm';
import { processIngestion } from './process-ingestion';

export interface IngestionQueueConsumerDeps {
  db: Database;
  logger: Logger;
  createLLM(): LLM;
  createEmbedder(): Embedder;
  createVectorStore(): VectorStore;
  nowMs(): number;
}

/**
 * Runtime-neutral ingestion queue consumer. Platform adapters translate their
 * native queue message into `QueueDelivery`; all durability decisions here are
 * expressed as generic ack/retry calls.
 */
export async function handleIngestionDelivery(
  delivery: QueueDelivery<IngestionJobMessage>,
  deps: IngestionQueueConsumerDeps,
): Promise<void> {
  const body = delivery.body;
  const logger = deps.logger.child({
    job_id: body.job_id,
    correlation_id: body.correlation_id,
    org_id: body.org_id,
    space_id: body.space_id,
    user_id: body.user_id,
  });
  const queueDelayMs =
    typeof body.enqueued_at_ms === 'number'
      ? Math.max(0, deps.nowMs() - body.enqueued_at_ms)
      : undefined;

  logger.info('ingestion.job_received', {
    source_count: body.source_ids.length,
    attempt: delivery.attempts,
    queue_delay_ms: queueDelayMs,
  });

  try {
    // One LLM + one embedder per job so totalTokens aggregates across every
    // source. Reinstantiating per source would lose attribution.
    const llm = deps.createLLM();
    const embedder = deps.createEmbedder();
    const vectorStore = deps.createVectorStore();
    await processIngestion(body, {
      db: deps.db,
      llm,
      embedder,
      vectorStore,
      logger,
    });
    delivery.ack();
  } catch (err) {
    // Outer failure path — DB went away mid-run, factory threw, etc.
    // Don't ack; let the queue runtime retry or DLQ according to its policy.
    logger.error('ingestion.job_unhandled_error', {
      attempt: delivery.attempts,
      error_category: 'internal',
      dependency: 'pipeline',
    }, err);
    delivery.retry();
  }
}
