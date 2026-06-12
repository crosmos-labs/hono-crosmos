import type { IngestionJobMessage } from '@crosmos/types';

/**
 * Queue port — abstracted so the producer can swap Cloudflare Queues for
 * something else (Kafka, SQS, in-memory test double) without touching
 * routes. Mirrors Python's `app/worker/ports.py:QueueService`.
 *
 * Why a port at all (since Cloudflare's `Queue` binding is already an
 * interface)? Three reasons:
 *
 *  1. `queueDepth` doesn't exist natively on Cloudflare Queues — every
 *     backend that wants to enforce backpressure has to source the number
 *     from somewhere. The port hides that choice (DB count vs Durable
 *     Object counter, see decisions.md §4) from the routes.
 *  2. Tests want a `NoopQueueService` that records calls in memory.
 *  3. The producer doesn't care that the wire format is JSON over the CF
 *     Queues API — it just knows it's submitting an `IngestionJobMessage`.
 */
export interface QueueService {
  /** Enqueue one ingestion job. Fire-and-forget from the caller's view. */
  enqueue(message: IngestionJobMessage): Promise<void>;

  /**
   * Best-effort low-latency trigger: ask the consumer to start this job NOW,
   * bypassing the queue's cold-delivery latency. Call AFTER `enqueue` (the
   * queue copy is the durable backstop) and dispatch via `waitUntil` — never
   * block a response on it. Backends without a push path (or test doubles)
   * no-op; the enqueued message still gets the job done.
   */
  kick(message: IngestionJobMessage): Promise<void>;

  /** Approximate count of pending+processing jobs — for backpressure. */
  queueDepth(): Promise<number>;
}
