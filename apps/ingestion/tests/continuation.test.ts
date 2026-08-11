/**
 * P0-C — continuations vs failure attempts.
 *
 * `max_retries = 15` on the ingestion queue is a FAILURE budget: it exists so a
 * job whose RPC run died silently is re-polled until its lease expires, and so a
 * persistently broken job eventually reaches the DLQ. Before this change the
 * consumer also spent that budget on healthy forward progress — a large source
 * deliberately processes `MAX_CHUNKS_PER_INVOCATION` chunks and asks to resume,
 * so a valid 200-chunk source dead-lettered after 15 deliveries without a single
 * processing failure.
 *
 * These tests pin the split: progress publishes a fresh message and acks; every
 * failure shape stays on the delivery retry budget; and no path ever acks
 * without a durable copy existing somewhere.
 */
import { describe, expect, mock, test } from 'bun:test';
import type { Logger } from '@crosmos/observability';
import type { IngestionJobMessage } from '@crosmos/types';
import { MAX_JOB_CONTINUATIONS } from '../src/constants';
import type { IngestionRunResult } from '../src/process-ingestion';
import {
  handleIngestionDelivery,
  type IngestionQueueConsumerDeps,
} from '../src/queue-consumer';

const BASE_MESSAGE: IngestionJobMessage = {
  task: 'process_ingestion',
  job_id: 'job-1',
  correlation_id: 'corr-1',
  org_id: 1,
  space_id: 2,
  user_id: 3,
  source_ids: [10, 11],
  enqueued_at_ms: 1_000,
};

interface Harness {
  acks: number;
  retries: { delaySeconds?: number }[];
  published: IngestionJobMessage[];
  events: { level: string; event: string; fields?: Record<string, unknown> }[];
}

function fakeLogger(events: Harness['events']): Logger {
  const record =
    (level: string) =>
    (event: string, fields?: Record<string, unknown>) => {
      events.push({ level, event, fields });
    };
  const logger: Logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
    time: async (_event, _fields, fn) => fn(),
  };
  return logger;
}

/**
 * Drive one delivery with a stubbed `processIngestion` result. `mock.module`
 * patches the module the consumer imports, so the consumer's real ack/retry
 * decision logic runs unmodified.
 */
async function deliver(options: {
  result: IngestionRunResult;
  message?: Partial<IngestionJobMessage>;
  attempts?: number;
  withProducer?: boolean;
  publishError?: Error;
  processThrows?: Error;
}): Promise<Harness> {
  const harness: Harness = { acks: 0, retries: [], published: [], events: [] };

  await mock.module('../src/process-ingestion', () => ({
    processIngestion: async () => {
      if (options.processThrows) throw options.processThrows;
      return options.result;
    },
  }));

  const deps: IngestionQueueConsumerDeps = {
    db: {} as never,
    logger: fakeLogger(harness.events),
    createLLM: () => ({ totalTokens: 0 }) as never,
    createEmbedder: () => ({ totalTokens: 0 }) as never,
    createVectorStore: () => ({}) as never,
    nowMs: () => 5_000,
    ...(options.withProducer === false
      ? {}
      : {
          sendContinuation: async (message: IngestionJobMessage) => {
            if (options.publishError) throw options.publishError;
            harness.published.push(message);
          },
        }),
  };

  await handleIngestionDelivery(
    {
      body: { ...BASE_MESSAGE, ...options.message },
      attempts: options.attempts ?? 1,
      ack: () => {
        harness.acks += 1;
      },
      retry: (opts) => {
        harness.retries.push(opts ?? {});
      },
    },
    deps,
  );

  return harness;
}

const eventNames = (h: Harness) => h.events.map((e) => e.event);

describe('requeue_incomplete — healthy forward progress', () => {
  test('publishes a fresh continuation and acks the current delivery', async () => {
    const h = await deliver({
      result: { outcome: 'requeue_incomplete', chunksProcessed: 8 },
      attempts: 4,
    });

    expect(h.published).toHaveLength(1);
    expect(h.acks).toBe(1);
    // The failure budget is untouched — this is the whole point of P0-C.
    expect(h.retries).toHaveLength(0);
    expect(eventNames(h)).toContain('ingestion.job_continuation_published');
  });

  test('the continuation carries the same job and correlation identity', async () => {
    const h = await deliver({
      result: { outcome: 'requeue_incomplete', chunksProcessed: 3 },
    });

    const [continuation] = h.published;
    expect(continuation!.job_id).toBe(BASE_MESSAGE.job_id);
    expect(continuation!.correlation_id).toBe(BASE_MESSAGE.correlation_id);
    expect(continuation!.source_ids).toEqual(BASE_MESSAGE.source_ids);
    expect(continuation!.org_id).toBe(BASE_MESSAGE.org_id);
    expect(continuation!.space_id).toBe(BASE_MESSAGE.space_id);
    expect(continuation!.user_id).toBe(BASE_MESSAGE.user_id);
  });

  test('the enqueue timestamp is refreshed so queue-delay measures this hop', async () => {
    const h = await deliver({
      result: { outcome: 'requeue_incomplete', chunksProcessed: 3 },
    });
    expect(h.published[0]!.enqueued_at_ms).toBe(5_000);
  });

  test('continuation_count starts at 1 and increments across hops', async () => {
    const first = await deliver({
      result: { outcome: 'requeue_incomplete', chunksProcessed: 8 },
    });
    expect(first.published[0]!.continuation_count).toBe(1);

    const later = await deliver({
      result: { outcome: 'requeue_incomplete', chunksProcessed: 8 },
      message: { continuation_count: 41 },
    });
    expect(later.published[0]!.continuation_count).toBe(42);
  });

  test('a source needing far more than max_retries windows keeps continuing', async () => {
    // 25 consecutive budget-limited invocations — well past the 15-delivery
    // failure budget the old code would have consumed.
    let carried: IngestionJobMessage = { ...BASE_MESSAGE };
    for (let window = 1; window <= 25; window++) {
      const h = await deliver({
        result: { outcome: 'requeue_incomplete', chunksProcessed: 8 },
        message: carried,
      });
      expect(h.acks).toBe(1);
      expect(h.retries).toHaveLength(0);
      expect(h.published[0]!.continuation_count).toBe(window);
      carried = h.published[0]!;
    }
  });
});

describe('requeue_incomplete — refusal paths keep the job durable', () => {
  test('a publish failure leaves the current delivery retryable and unacked', async () => {
    const h = await deliver({
      result: { outcome: 'requeue_incomplete', chunksProcessed: 8 },
      publishError: new Error('queue unavailable'),
    });

    expect(h.acks).toBe(0);
    expect(h.retries).toHaveLength(1);
    expect(eventNames(h)).toContain('ingestion.job_continuation_publish_failed');
  });

  test('zero checkpoint progress is refused and demoted to the retry budget', async () => {
    const h = await deliver({
      result: { outcome: 'requeue_incomplete', chunksProcessed: 0 },
      message: { continuation_count: 3 },
    });

    expect(h.published).toHaveLength(0);
    expect(h.acks).toBe(0);
    expect(h.retries).toHaveLength(1);
    const refusal = h.events.find(
      (e) => e.event === 'ingestion.job_continuation_refused',
    );
    expect(refusal?.level).toBe('error');
    expect(refusal?.fields?.reason).toBe('no_checkpoint_progress');
  });

  test('the continuation ceiling is enforced', async () => {
    const h = await deliver({
      result: { outcome: 'requeue_incomplete', chunksProcessed: 8 },
      message: { continuation_count: MAX_JOB_CONTINUATIONS },
    });

    expect(h.published).toHaveLength(0);
    expect(h.retries).toHaveLength(1);
    expect(
      h.events.find((e) => e.event === 'ingestion.job_continuation_refused')
        ?.fields?.reason,
    ).toBe('continuation_limit_reached');
  });

  test('the last continuation below the ceiling is still published', async () => {
    const h = await deliver({
      result: { outcome: 'requeue_incomplete', chunksProcessed: 8 },
      message: { continuation_count: MAX_JOB_CONTINUATIONS - 1 },
    });
    expect(h.published[0]!.continuation_count).toBe(MAX_JOB_CONTINUATIONS);
    expect(h.acks).toBe(1);
  });

  test('without a producer binding it falls back to the old re-queue behavior', async () => {
    const h = await deliver({
      result: { outcome: 'requeue_incomplete', chunksProcessed: 8 },
      withProducer: false,
    });

    expect(h.acks).toBe(0);
    expect(h.retries).toHaveLength(1);
    const refusal = h.events.find(
      (e) => e.event === 'ingestion.job_continuation_refused',
    );
    // A missing binding is a deployment state, not a pipeline error.
    expect(refusal?.level).toBe('warn');
    expect(refusal?.fields?.reason).toBe('no_producer_binding');
  });
});

describe('failure and polling outcomes stay on the delivery retry budget', () => {
  test('retry_transient never publishes a continuation', async () => {
    const h = await deliver({
      result: { outcome: 'retry_transient', chunksProcessed: 8 },
    });

    expect(h.published).toHaveLength(0);
    expect(h.acks).toBe(0);
    expect(h.retries).toHaveLength(1);
    expect(eventNames(h)).toContain('ingestion.job_requeued');
  });

  test('skipped_in_flight keeps polling on the retry budget', async () => {
    const h = await deliver({
      result: { outcome: 'skipped_in_flight', chunksProcessed: 0 },
    });

    expect(h.published).toHaveLength(0);
    expect(h.acks).toBe(0);
    expect(h.retries).toHaveLength(1);
    expect(eventNames(h)).toContain('ingestion.job_backstop_requeued');
  });

  test('an unhandled error retries without publishing', async () => {
    const h = await deliver({
      result: { outcome: 'processed', chunksProcessed: 0 },
      processThrows: new Error('db gone'),
    });

    expect(h.published).toHaveLength(0);
    expect(h.acks).toBe(0);
    expect(h.retries).toHaveLength(1);
    expect(eventNames(h)).toContain('ingestion.job_unhandled_error');
  });

  test.each([
    ['processed'],
    ['skipped_terminal'],
    ['skipped_not_found'],
  ] as const)('%s acks without publishing', async (outcome) => {
    const h = await deliver({
      result: { outcome, chunksProcessed: 0 },
    });

    expect(h.acks).toBe(1);
    expect(h.retries).toHaveLength(0);
    expect(h.published).toHaveLength(0);
  });
});
