import * as Sentry from '@sentry/cloudflare';
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
 * serially per isolate but in parallel across isolates — see
 * docs/ingestion_migration/decisions.md §4.
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

    for (const message of batch.messages) {
      const body = message.body as IngestionJobMessage;
      console.log('ingestion_job_received', {
        job_id: body.job_id,
        correlation_id: body.correlation_id,
        org_id: body.org_id,
        space_id: body.space_id,
        source_count: body.source_ids.length,
        attempt: message.attempts,
      });

      // One LLM + one embedder per job so totalTokens aggregates across
      // every source. Reinstantiating per source would lose attribution.
      const llm = getLLM(env);
      const embedder = getEmbedder(env);

      try {
        await processIngestion(body, { db, llm, embedder });
        message.ack();
      } catch (err) {
        // Outer failure path — DB went away mid-run, factory threw, etc.
        // Don't ack; let Cloudflare Queues retry (or DLQ on the final attempt).
        Sentry.captureException(err);
        console.error('ingestion_job_unhandled_error', {
          job_id: body.job_id,
          attempt: message.attempts,
          error: err instanceof Error ? err.message : String(err),
        });
        message.retry();
      }
    }
  },
};

export default Sentry.withSentry(
  (env) => {
    const e = env as Env | undefined;
    return {
      dsn: e?.SENTRY_DSN ?? '',
      environment: e?.ENVIRONMENT ?? 'development',
      tracesSampleRate: e?.ENVIRONMENT === 'production' ? 0.1 : 1.0,
      enabled: Boolean(e?.SENTRY_DSN),
    };
  },
  handler,
);
