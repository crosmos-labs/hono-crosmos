import type { Database } from '@crosmos/db';
import type { IngestionJobMessage } from '@crosmos/types';
import type { IngestionRpc } from '../../bindings';
import { countActiveIngestionJobs } from '../job-store/pg';
import type { QueueService } from './port';

/**
 * Cloudflare Queues producer adapter.
 *
 * `inFlightJobCount` uses Postgres (`COUNT(*) ingestion_jobs` over the non-stale
 * pending+processing rows) rather than a Durable Object counter — Cloudflare
 * Queues expose no native backlog depth, so this DB count is the proxy. Slightly
 * stale, but bounded by the queue-depth ceiling and runs over Hyperdrive, so
 * adds maybe ~20ms per `POST /sources`. Revisit if it shows up in p95.
 */
export class CloudflareQueueService implements QueueService {
  constructor(
    private readonly queue: Queue<IngestionJobMessage>,
    private readonly db: Database,
    private readonly ingestion: IngestionRpc,
    /** Staleness window for the in-flight count (issue #3/#6). */
    private readonly staleMinutes?: number,
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

  async inFlightJobCount(): Promise<number> {
    return countActiveIngestionJobs(this.db, this.staleMinutes);
  }
}
