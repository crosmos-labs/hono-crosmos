import type { Database } from '@crosmos/db';
import type { IngestionJobMessage } from '@crosmos/types';
import type { IngestionRpc } from '../../bindings';
import { countActiveIngestionJobs } from '../job-store/pg';
import type { QueueService } from './port';

/**
 * Cloudflare Queues producer adapter.
 *
 * `queueDepth` uses Postgres (`COUNT(*) ingestion_jobs WHERE status IN
 * (pending, processing)`) rather than a Durable Object counter. Slightly stale, but bounded at
 * the 5000 ceiling and runs over Hyperdrive, so adds maybe ~20ms per
 * `POST /sources`. Revisit if it shows up in p95.
 */
export class CloudflareQueueService implements QueueService {
  constructor(
    private readonly queue: Queue<IngestionJobMessage>,
    private readonly db: Database,
    private readonly ingestion: IngestionRpc,
  ) {}

  async enqueue(message: IngestionJobMessage): Promise<void> {
    await this.queue.send(message);
  }

  async kick(message: IngestionJobMessage): Promise<void> {
    // Direct RPC over the service binding. Returns as soon as the consumer has
    // scheduled the run, so this resolves in ~ms. The atomic job claim on the
    // consumer side keeps this from racing the queue backstop delivery.
    await this.ingestion.ingest(message);
  }

  async queueDepth(): Promise<number> {
    return countActiveIngestionJobs(this.db);
  }
}
