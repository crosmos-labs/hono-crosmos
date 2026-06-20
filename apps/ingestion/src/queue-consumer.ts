import type { Database } from '@crosmos/db';
import type { Logger } from '@crosmos/observability';
import type { QueueDelivery } from '@crosmos/runtime';
import type { IngestionJobMessage } from '@crosmos/types';
import type { VectorStore } from '@crosmos/vector';
import { BACKSTOP_RETRY_DELAY_SECONDS } from './constants';
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
  /** Analytics Engine dataset for outcome metrics (optional / no-op if unset). */
  analytics?: AnalyticsEngineDataset;
  /** Deployment environment, used as a metrics tag. */
  environment?: string;
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
    const outcome = await processIngestion(body, {
      db: deps.db,
      llm,
      embedder,
      vectorStore,
      logger,
      analytics: deps.analytics,
      environment: deps.environment,
    });

    // The queue is the durable backstop behind the direct RPC fast path.
    // `skipped_in_flight` means the RPC trigger holds a live lease and is
    // (presumably) still running — we must NOT ack, or we'd drop the only
    // durable copy of this job. Re-queue with a delay to re-check later; we'll
    // either find it terminal (ack) or recover it once the lease expires
    // (claim + process). Every other outcome is settled → ack.
    if (outcome === 'skipped_in_flight') {
      logger.info('ingestion.job_backstop_requeued', {
        delay_seconds: BACKSTOP_RETRY_DELAY_SECONDS,
        attempt: delivery.attempts,
      });
      delivery.retry({ delaySeconds: BACKSTOP_RETRY_DELAY_SECONDS });
    } else if (outcome === 'retry_transient' || outcome === 'requeue_incomplete') {
      // Two non-terminal "keep going" outcomes, both of which reset the job to
      // `pending`:
      //  - retry_transient: a dependency (vector store / embedder / LLM) was
      //    degraded (issue #4).
      //  - requeue_incomplete: the per-invocation chunk budget ran out before all
      //    sources were processed (issue #2); completed sources are skipped on
      //    the re-run and the rest continue in a fresh invocation.
      // Either way we must NOT ack (that would drop the only durable copy of a
      // job that hasn't finished) — re-queue with a delay so it's re-delivered.
      logger.warn('ingestion.job_requeued', {
        reason: outcome,
        delay_seconds: BACKSTOP_RETRY_DELAY_SECONDS,
        attempt: delivery.attempts,
      });
      delivery.retry({ delaySeconds: BACKSTOP_RETRY_DELAY_SECONDS });
    } else {
      delivery.ack();
    }
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
