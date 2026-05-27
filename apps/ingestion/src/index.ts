import { createLogger } from '@crosmos/observability';
import type { IngestionJobMessage } from '@crosmos/types';
import type { Env } from './bindings';
import { getDb } from './db';
import { getEmbedder } from './integrations/embeddings';
import { getLLM } from './integrations/llm';
import { processIngestion } from './process-ingestion';

/**
 * Ingestion Worker — Cloudflare Queue consumer.
 *
 * One queue message = one ingestion job (a job may carry many `source_ids`).
 * `wrangler.toml` is configured with `max_batch_size: 1` so we process jobs
 * serially per isolate but in parallel across isolates. See .codex/pipelines.md.
 *
 * Acking strategy: a job that completes (in any terminal state — completed /
 * partial / failed / cancelled) is acked. An *unhandled* exception bubbles
 * out without acking, so Cloudflare Queues retries it according to the
 * consumer's `max_retries` (currently 3) and eventually DLQs.
 *
 * Per-source failures inside the pipeline do NOT throw out of
 * `processIngestion` — they are captured into the job's result payload and
 * the job ends in `partial` or `failed`. That's by design: requeuing the
 * whole batch on one bad LLM response would be wasteful.
 */
const handler: ExportedHandler<Env> = {
  async queue(batch, env): Promise<void> {
    const db = getDb(env);
    const rootLogger = createLogger({
      service: 'ingestion',
      environment: env.ENVIRONMENT,
    });

    for (const message of batch.messages) {
      const body = message.body as IngestionJobMessage;
      const logger = rootLogger.child({
        job_id: body.job_id,
        correlation_id: body.correlation_id,
        org_id: body.org_id,
        space_id: body.space_id,
        user_id: body.user_id,
      });
      const queueDelayMs =
        typeof body.enqueued_at_ms === 'number'
          ? Math.max(0, Date.now() - body.enqueued_at_ms)
          : undefined;

      logger.info('ingestion.job_received', {
        job_id: body.job_id,
        correlation_id: body.correlation_id,
        org_id: body.org_id,
        space_id: body.space_id,
        user_id: body.user_id,
        source_count: body.source_ids.length,
        attempt: message.attempts,
        queue_delay_ms: queueDelayMs,
      });

      // One LLM + one embedder per job so totalTokens aggregates across
      // every source. Reinstantiating per source would lose attribution.
      const llm = getLLM(env);
      const embedder = getEmbedder(env);

      try {
        await processIngestion(body, { db, llm, embedder, logger });
        message.ack();
      } catch (err) {
        // Outer failure path — DB went away mid-run, factory threw, etc.
        // Don't ack; let Cloudflare Queues retry (or DLQ on the final attempt).
        logger.error('ingestion.job_unhandled_error', {
          attempt: message.attempts,
        }, err);
        message.retry();
      }
    }
  },
};

export default handler;
