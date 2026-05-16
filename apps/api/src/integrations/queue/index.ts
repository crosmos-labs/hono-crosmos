import type { Database } from '@crosmos/db';
import type { IngestionJobMessage } from '@crosmos/types';
import type { Env } from '../../bindings';
import { CloudflareQueueService } from './cloudflare';
import type { QueueService } from './port';

export type { QueueService } from './port';

/**
 * Returns the configured queue service. Today there's only the Cloudflare
 * Queues adapter. Routes get one via `getQueueService(c.env, db)`.
 */
export function getQueueService(env: Env, db: Database): QueueService {
  return new CloudflareQueueService(
    env.INGESTION_QUEUE as Queue<IngestionJobMessage>,
    db,
  );
}
