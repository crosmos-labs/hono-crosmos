import { WorkerEntrypoint } from 'cloudflare:workers';
import { createLogger, type Logger } from '@crosmos/observability';
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

  /** Queue consumer entrypoint (durable backstop). */
  async queue(batch: MessageBatch<IngestionJobMessage>): Promise<void> {
    const db = getDb(this.env);
    const rootLogger = createLogger({
      service: 'ingestion',
      environment: this.env.ENVIRONMENT,
    });
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
      await processIngestion(message, {
        db,
        llm: getLLM(this.env),
        embedder: getEmbedder(this.env),
        vectorStore: getVectorStore(this.env, db),
        logger,
      });
    } catch (err) {
      // Don't rethrow — the queue backstop owns recovery. The job is left
      // non-terminal; either its claim was never taken (queue claims cleanly)
      // or it sits in `processing` until the lease lapses (queue reclaims).
      logger.error(
        'ingestion.rpc_run_failed',
        { error_category: 'internal', dependency: 'pipeline' },
        err,
      );
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
    };
  }
}

export default IngestionWorker;
