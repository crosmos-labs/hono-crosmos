import { createLogger } from '@crosmos/observability';
import { systemClock } from '@crosmos/runtime';
import type { IngestionJobMessage } from '@crosmos/types';
import type { Env } from './bindings';
import { getDb } from './db';
import { getEmbedder } from './integrations/embeddings';
import { getLLM } from './integrations/llm';
import { getVectorStore } from './integrations/vector-store';
import { handleIngestionDelivery } from './queue-consumer';

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
      await handleIngestionDelivery(
        {
          body: message.body as IngestionJobMessage,
          attempts: message.attempts,
          ack: () => message.ack(),
          retry: () => message.retry(),
        },
        {
          db,
          logger: rootLogger,
          createLLM: () => getLLM(env),
          createEmbedder: () => getEmbedder(env),
          createVectorStore: () => getVectorStore(env, db),
          nowMs: () => systemClock.nowMs(),
        },
      );
    }
  },
};

export default handler;
