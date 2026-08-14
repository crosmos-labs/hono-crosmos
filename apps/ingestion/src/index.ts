import { WorkerEntrypoint } from 'cloudflare:workers';
import { createLogger, createMetrics, type Logger } from '@crosmos/observability';
import { systemClock } from '@crosmos/runtime';
import type { IngestionJobMessage } from '@crosmos/types';
import type { Env } from './bindings';
import { getDb } from './db';
import { getEmbedder } from './integrations/embeddings';
import { getLLM } from './integrations/llm';
import { getVectorStore } from './integrations/vector-store';
import { processIngestion } from './process-ingestion';
import {
  handleIngestionDelivery,
  type IngestionQueueConsumerDeps,
} from './queue-consumer';
import { resetJobForRetry } from './job-store';

/**
 * Ingestion Worker.
 *
 * Two triggers can start the same job; they coordinate through an atomic claim
 * (a DB compare-and-swap on `ingestion_jobs.status`, see `claimJob`):
 *
 *  1. `ingest()` RPC — the *fast path*. The API worker invokes this over a
 *     service binding the moment a job is enqueued, so ingestion begins within
 *     milliseconds instead of waiting out Cloudflare Queues' cold-queue
 *     delivery latency (tens of seconds for low-volume queues).
 *
 *  2. `queue()` consumer — the *durable backstop*. Every job is ALSO enqueued.
 *     If the RPC never ran (API died after enqueue) or the RPC's background
 *     run died mid-flight (isolate eviction — `waitUntil` has no auto-retry),
 *     the queue delivery picks the job up with full retry + DLQ semantics.
 *
 * The claim guarantees these never double-process a healthy in-flight job and
 * that an abandoned one is recovered once its lease expires. So we keep the
 * queue's reliability while shedding its latency.
 *
 * `wrangler.toml` uses `max_batch_size: 1`, so we process one job per queue
 * invocation (serial per isolate, parallel across isolates).
 */
export class IngestionWorker extends WorkerEntrypoint<Env> {
  /**
   * Direct RPC entrypoint (fast path). Returns to the caller immediately after
   * scheduling the run on `waitUntil`, so the API worker is never held open for
   * the duration of ingestion. The actual work runs in this worker's own
   * invocation lifetime.
   *
   * Failures here are intentionally swallowed (logged only): the durable queue
   * copy of this job is the backstop. If this run never claims the job or dies,
   * the queue delivery recovers it.
   */
  async ingest(message: IngestionJobMessage): Promise<void> {
    this.ctx.waitUntil(this.run(message));
  }

  /** Queue consumer entrypoint (durable backstop + dead-letter visibility). */
  async queue(batch: MessageBatch<IngestionJobMessage>): Promise<void> {
    const db = getDb(this.env);
    const rootLogger = createLogger({
      service: 'ingestion',
      environment: this.env.ENVIRONMENT,
    });

    // Dead-letter queue: messages that exhausted the main queue's retries land
    // here. We deliberately DON'T reprocess inline (that risks a tight failure
    // loop) — instead we make the exhaustion VISIBLE (error log + metric so it
    // can be alerted on) and ack so it doesn't pile up. Actual recovery is the
    // API worker's cron re-drive sweep, which re-attempts the underlying
    // non-completed sources with a bounded per-source attempt budget.
    if (batch.queue.endsWith('-dlq')) {
      const metrics = createMetrics(this.env.ANALYTICS, {
        service: 'ingestion',
        environment: this.env.ENVIRONMENT,
        version: this.env.CF_VERSION_METADATA?.id,
      });
      for (const message of batch.messages) {
        const body = message.body;
        rootLogger.error('ingestion.job_dead_lettered', {
          job_id: body.job_id,
          correlation_id: body.correlation_id,
          org_id: body.org_id,
          space_id: body.space_id,
          user_id: body.user_id,
          source_count: body.source_ids?.length,
          attempts: message.attempts,
          error_category: 'internal',
          dependency: 'pipeline',
        });
        metrics.count('ingestion_dead_lettered', {
          tags: [this.env.ENVIRONMENT],
          index: 'ingestion_dead_lettered',
        });
        message.ack();
      }
      return;
    }

    const deps = this.consumerDeps(db, rootLogger);

    for (const message of batch.messages) {
      await handleIngestionDelivery(
        {
          body: message.body,
          attempts: message.attempts,
          ack: () => message.ack(),
          retry: (opts) => message.retry(opts),
        },
        deps,
      );
    }
  }

  /** Background run for the RPC fast path. */
  private async run(message: IngestionJobMessage): Promise<void> {
    const db = getDb(this.env);
    const logger = createLogger({
      service: 'ingestion',
      environment: this.env.ENVIRONMENT,
      base: {
        job_id: message.job_id,
        correlation_id: message.correlation_id,
        org_id: message.org_id,
        space_id: message.space_id,
        user_id: message.user_id,
        trigger: 'rpc',
      },
    });
    try {
      const { outcome } = await processIngestion(message, {
        db,
        llm: getLLM(this.env),
        embedder: getEmbedder(this.env),
        vectorStore: getVectorStore(this.env, db),
        logger,
        analytics: this.env.ANALYTICS,
        environment: this.env.ENVIRONMENT,
        version: this.env.CF_VERSION_METADATA?.id,
      });
      // On the RPC fast path we don't own the queue message, so we can't re-queue
      // it ourselves — but `processIngestion` already reset the job to `pending`,
      // and the durable queue copy (enqueued at creation) will be delivered and
      // re-attempt it via the queue consumer's retry path. Just record it.
      //
      // Deliberately NO continuation is published here (P0-C). The RPC path's
      // original durable queue message is still outstanding and will claim the
      // pending job; publishing from here as well would put two live copies of
      // the same job on the queue for no benefit.
      //  - retry_transient: a dependency was degraded (#4).
      //  - requeue_incomplete: the per-invocation chunk budget ran out before all
      //    sources finished; the re-delivery continues the remaining ones (#2).
      if (outcome === 'retry_transient' || outcome === 'requeue_incomplete') {
        logger.warn('ingestion.rpc_run_incomplete', { reason: outcome });
      }
    } catch (err) {
      // Don't rethrow — the queue backstop owns recovery. But don't wait out
      // the full lease either: proactively flip a job we claimed-then-wedged in
      // `processing` back to `pending` so the queue backstop can re-claim it
      // promptly. `resetJobForRetry` is a guarded CAS (only touches a row still
      // `processing`), so it's a no-op if the claim was never taken or another
      // trigger already moved the job terminal. We deliberately DON'T touch
      // source rows: the re-run's idempotency gate 2 re-processes any source
      // left `processing` and skips terminal ones, so blanket-resetting sources
      // would needlessly redo completed work and erase accurate status.
      logger.error(
        'ingestion.rpc_run_failed',
        { error_category: 'internal', dependency: 'pipeline' },
        err,
      );
      try {
        const reset = await resetJobForRetry(db, message.job_id);
        if (reset) {
          logger.info('ingestion.rpc_run_reset_for_retry', {
            status: 'pending',
            reason: 'rpc_run_failed',
          });
        }
      } catch (resetErr) {
        // Reset is best-effort; the lease-expiry path still recovers the job.
        logger.warn('ingestion.rpc_run_reset_failed', {}, resetErr);
      }
    }
  }

  private consumerDeps(
    db: ReturnType<typeof getDb>,
    logger: Logger,
  ): IngestionQueueConsumerDeps {
    return {
      db,
      logger,
      createLLM: () => getLLM(this.env),
      createEmbedder: () => getEmbedder(this.env),
      createVectorStore: () => getVectorStore(this.env, db),
      nowMs: () => systemClock.nowMs(),
      // Left undefined when the producer binding is absent, which makes the
      // consumer fall back to re-queueing the current delivery.
      sendContinuation: this.env.INGESTION_QUEUE
        ? async (message) => {
            await this.env.INGESTION_QUEUE!.send(message);
          }
        : undefined,
      analytics: this.env.ANALYTICS,
      environment: this.env.ENVIRONMENT,
      version: this.env.CF_VERSION_METADATA?.id,
    };
  }
}

export default IngestionWorker;
