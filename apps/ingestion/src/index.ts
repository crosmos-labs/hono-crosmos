import * as Sentry from '@sentry/cloudflare';
import type { Env } from './bindings';

/**
 * Ingestion Worker — Cloudflare Queue consumer.
 *
 * This is a scaffold. The real pipeline (memory extraction → graph
 * extraction → embedding → entity resolution → edge creation) is ported in
 * Phase B per docs/ingestion_migration/decisions.md §13. For now the
 * consumer just acks each message so the queue plumbing is exercisable
 * end-to-end as soon as the producer (POST /sources) ships.
 *
 * Integrations (LLM / embeddings / reranker) live in `./integrations/*` and
 * are reached through their factories (`getLLM`, `getEmbedder`,
 * `getReranker`) — never instantiate a concrete provider here.
 */
interface IngestionJobMessage {
  task: 'process_ingestion';
  job_id: string;
  correlation_id: string;
  org_id: number;
  space_id: number;
  user_id: number;
  source_ids: number[];
}

const handler: ExportedHandler<Env> = {
  async queue(batch, _env): Promise<void> {
    for (const message of batch.messages) {
      const body = message.body as IngestionJobMessage;
      console.log('ingestion job received', {
        job_id: body.job_id,
        correlation_id: body.correlation_id,
        org_id: body.org_id,
        space_id: body.space_id,
        source_count: body.source_ids.length,
        attempt: message.attempts,
      });
      // TODO(phase-b): port app/worker/tasks.py:process_ingestion
      message.ack();
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
