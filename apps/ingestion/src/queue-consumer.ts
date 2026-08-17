import type { Database } from '@crosmos/db';
import {
  createMetrics,
  createStageRecorder,
  type Logger,
  type TraceProvider,
} from '@crosmos/observability';
import type { QueueDelivery } from '@crosmos/runtime';
import type { IngestionJobMessage } from '@crosmos/types';
import type { VectorStore } from '@crosmos/vector';
import {
  BACKSTOP_RETRY_DELAY_SECONDS,
  MAX_JOB_CONTINUATIONS,
} from './constants';
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
  /**
   * Publish a fresh continuation message onto the SAME ingestion queue this
   * consumer reads (P0-C). Optional: when it is absent — local dev without the
   * producer binding, or a test double — the consumer falls back to the old
   * behavior of re-queueing the current delivery, which is correct but spends
   * the delivery retry budget on healthy progress.
   */
  sendContinuation?(message: IngestionJobMessage): Promise<void>;
  /** Analytics Engine dataset for outcome metrics (optional / no-op if unset). */
  analytics?: AnalyticsEngineDataset;
  /** Deployment environment, used as a metrics tag. */
  environment?: string;
  /** Cloudflare Worker version id, truncated by `createMetrics`. */
  version?: string;
  /** Cloudflare custom-spans surface; omitted in local dev and unit tests. */
  tracing?: TraceProvider;
}

/**
 * Handle a `requeue_incomplete` outcome by publishing a fresh continuation and
 * acking the current delivery — or, when that isn't safe/possible, by falling
 * back to re-queueing the current delivery.
 *
 * The ordering is load-bearing for durability: the continuation is published
 * BEFORE the ack, and a publish failure leaves the current message unacked and
 * retryable. There is never a window in which no durable copy of the job exists.
 * A duplicate copy (published, then the ack lost) is harmless — the atomic job
 * claim collapses it.
 */
async function continueOrRetry(
  delivery: QueueDelivery<IngestionJobMessage>,
  deps: IngestionQueueConsumerDeps,
  logger: Logger,
  run: {
    body: IngestionJobMessage;
    continuationCount: number;
    chunksProcessed: number;
  },
): Promise<void> {
  const { body, continuationCount, chunksProcessed } = run;
  const next = continuationCount + 1;

  // Refuse to continue when this invocation committed nothing. A continuation
  // that advances no checkpoint would publish an identical message forever, so
  // it is demoted onto the delivery retry budget where the DLQ makes it visible.
  // (The budget path also still recovers the job if the cause was transient.)
  const madeProgress = chunksProcessed > 0;
  const withinBound = next <= MAX_JOB_CONTINUATIONS;

  if (!deps.sendContinuation || !madeProgress || !withinBound) {
    const reason = !deps.sendContinuation
      ? 'no_producer_binding'
      : !madeProgress
        ? 'no_checkpoint_progress'
        : 'continuation_limit_reached';
    // A stalled or runaway continuation is an anomaly worth alerting on; a
    // missing binding is a deployment/config state, not an error.
    const log = reason === 'no_producer_binding' ? logger.warn : logger.error;
    log.call(logger, 'ingestion.job_continuation_refused', {
      reason,
      chunks_processed: chunksProcessed,
      continuation_count: continuationCount,
      delay_seconds: BACKSTOP_RETRY_DELAY_SECONDS,
      attempt: delivery.attempts,
      ...(reason === 'no_producer_binding'
        ? {}
        : { error_category: 'internal', dependency: 'pipeline' }),
    });
    // tags: outcome, reason (both bounded enums — never ids).
    // values: continuation_count, chunks_processed.
    createMetrics(deps.analytics, {
      service: 'ingestion',
      environment: deps.environment,
      version: deps.version,
    }).count('ingestion_continuation', {
      tags: ['refused', reason],
      values: [continuationCount, chunksProcessed],
      index: 'ingestion_continuation',
    });
    delivery.retry({ delaySeconds: BACKSTOP_RETRY_DELAY_SECONDS });
    return;
  }

  // Same job and correlation IDs — a continuation is the same logical unit of
  // work, and lifecycle correlation must survive it (P2-1). Only the enqueue
  // timestamp (so queue-delay logs measure THIS hop) and the continuation
  // counter change.
  const continuation: IngestionJobMessage = {
    ...body,
    enqueued_at_ms: deps.nowMs(),
    continuation_count: next,
  };

  try {
    await deps.sendContinuation(continuation);
  } catch (err) {
    // The durable copy we hold is still the only one. Do NOT ack.
    logger.error(
      'ingestion.job_continuation_publish_failed',
      {
        continuation_count: continuationCount,
        chunks_processed: chunksProcessed,
        attempt: delivery.attempts,
        error_category: 'external_service',
        dependency: 'queue',
      },
      err,
    );
    delivery.retry({ delaySeconds: BACKSTOP_RETRY_DELAY_SECONDS });
    return;
  }

  logger.info('ingestion.job_continuation_published', {
    continuation_count: next,
    chunks_processed: chunksProcessed,
    attempt: delivery.attempts,
  });
  // A rising continuation_count with a flat chunks_processed is the signature of
  // a source that is churning without progressing.
  createMetrics(deps.analytics, {
    service: 'ingestion',
    environment: deps.environment,
    version: deps.version,
  }).count('ingestion_continuation', {
    tags: ['published', 'checkpoint_advanced'],
    values: [next, chunksProcessed],
    index: 'ingestion_continuation',
  });
  delivery.ack();
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
    trigger: 'queue',
  });
  const queueDelayMs =
    typeof body.enqueued_at_ms === 'number'
      ? Math.max(0, deps.nowMs() - body.enqueued_at_ms)
      : undefined;

  // Messages predating continuations (and every message the API produces) omit
  // this; zero is the correct reading of "never continued".
  const continuationCount = body.continuation_count ?? 0;

  logger.info('ingestion.job_received', {
    source_count: body.source_ids.length,
    attempt: delivery.attempts,
    queue_delay_ms: queueDelayMs,
    continuation_count: continuationCount,
  });
  if (queueDelayMs !== undefined) {
    createStageRecorder({
      logger,
      metrics: createMetrics(deps.analytics, {
        service: 'ingestion',
        environment: deps.environment,
        version: deps.version,
      }),
      event: 'ingestion.stage_completed',
      metric: 'ingestion_stage',
    }).record('queue_wait', 'ok', queueDelayMs);
  }

  try {
    // One LLM + one embedder per job so totalTokens aggregates across every
    // source. Reinstantiating per source would lose attribution.
    const llm = deps.createLLM();
    const embedder = deps.createEmbedder();
    const vectorStore = deps.createVectorStore();
    const { outcome, chunksProcessed } = await processIngestion(body, {
      db: deps.db,
      llm,
      embedder,
      vectorStore,
      logger,
      analytics: deps.analytics,
      environment: deps.environment,
      version: deps.version,
      tracing: deps.tracing,
    });

    // The queue is the durable backstop behind the direct RPC fast path.
    // `skipped_in_flight` means the RPC trigger holds a live lease and is
    // (presumably) still running — we must NOT ack, or we'd drop the only
    // durable copy of this job. Re-queue with a delay to re-check later; we'll
    // either find it terminal (ack) or recover it once the lease expires
    // (claim + process). This is polling a healthy job, but it deliberately
    // stays on the DELIVERY retry budget: `max_retries × delay` is sized to
    // outlast JOB_LEASE_MS precisely so this poll can't outlive the lease.
    if (outcome === 'skipped_in_flight') {
      logger.info('ingestion.job_backstop_requeued', {
        delay_seconds: BACKSTOP_RETRY_DELAY_SECONDS,
        attempt: delivery.attempts,
      });
      delivery.retry({ delaySeconds: BACKSTOP_RETRY_DELAY_SECONDS });
      return;
    }

    if (outcome === 'requeue_incomplete') {
      // Forward progress, not failure: the per-invocation chunk budget ran out
      // (issues #2/#9). Completed sources are persisted and each unfinished
      // source's durable checkpoint has advanced, so a fresh invocation resumes
      // from there. Publishing a NEW message resets the attempt counter, which
      // is the whole point of P0-C — a 200-chunk source needs ~25 invocations
      // and must not spend a failure budget of 15 to get them.
      await continueOrRetry(delivery, deps, logger, {
        body,
        continuationCount,
        chunksProcessed,
      });
      return;
    }

    if (outcome === 'retry_transient') {
      // A dependency (vector store / embedder / LLM) was degraded (issue #4).
      // This IS a failure, so it stays on the delivery retry budget and will
      // reach the DLQ — and thus visible alerting — if it never recovers.
      logger.warn('ingestion.job_requeued', {
        reason: outcome,
        delay_seconds: BACKSTOP_RETRY_DELAY_SECONDS,
        attempt: delivery.attempts,
        continuation_count: continuationCount,
      });
      delivery.retry({ delaySeconds: BACKSTOP_RETRY_DELAY_SECONDS });
      return;
    }

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
