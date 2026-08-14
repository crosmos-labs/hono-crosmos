/**
 * `processIngestion` — top-level consumer routine for one ingestion job.
 *
 * Mirrors `app/worker/tasks.py:process_ingestion`. Defensive idempotency
 * gates (decisions.md §5) come first: terminal jobs and non-pending sources
 * are skipped so a redelivered queue message never re-runs work.
 *
 * Errors are scoped tightly: an AI failure on one source doesn't poison the
 * batch. The job's final status rolls up to one of
 * completed / partial / failed / cancelled.
 */
import type { Database } from '@crosmos/db';
import {
  createMetrics,
  durationMs,
  type Logger,
  type TraceProvider,
} from '@crosmos/observability';
import type {
  IngestionJobMessage,
  IngestionJobResult,
  IngestionJobStatus,
  TenantScope,
} from '@crosmos/types';
import {
  BACKSTOP_RETRY_DELAY_SECONDS,
  CHUNK_HEARTBEAT_INTERVAL_MS,
  JOB_LEASE_MS,
  MAX_CHUNKS_PER_INVOCATION,
  SOURCE_RETRY_ATTEMPTS,
  SOURCE_RETRY_DELAY_MS,
} from './constants';
import { VectorStoreError, type VectorStore } from '@crosmos/vector';
import type { Embedder } from './integrations/embeddings';
import { EmbeddingRequestError } from './integrations/embeddings';
import type { LLM } from './integrations/llm';
import { LLMRequestError } from './integrations/llm';
import {
  ingestSource,
  type IngestResult,
} from './ingestion/pipeline';
import {
  claimJob,
  isJobCancelled,
  isSpaceActive,
  resetJobForRetry,
  updateJobStatus,
} from './job-store';
import {
  getSourceExtractionStatus,
  markSourcesFailed,
  markSourcesStatus,
  markUnprocessedSourcesCancelled,
} from './source-status';
import { recordIngestionUsage } from './usage';

/**
 * What `processIngestion` did with this delivery. Drives the queue consumer's
 * ack/retry decision:
 *  - `processed`         — we owned and ran the job to a terminal state → ack.
 *  - `skipped_terminal`  — already finished by another trigger → ack (no-op).
 *  - `skipped_not_found` — job row is gone → ack (nothing to recover).
 *  - `skipped_in_flight` — another trigger holds a live lease → the durable
 *                          copy must survive, so the queue consumer re-queues
 *                          with a delay and re-checks later.
 *  - `retry_transient`   — one or more sources failed on a RETRYABLE
 *                          infrastructure error (vector store / embedder / LLM
 *                          5xx-429), so the job is NOT marked terminal: it's
 *                          reset to `pending` and the queue consumer re-queues
 *                          it with a delay. Avoids silently dropping a session
 *                          just because a dependency was briefly red (issue #4).
 *  - `requeue_incomplete`— the per-invocation chunk budget was exhausted before
 *                          all sources were processed (issue #2). Completed
 *                          sources are persisted (skipped on the re-run); the job
 *                          is reset to `pending` and re-queued so the remaining
 *                          sources run in a fresh invocation with a full budget.
 */
export type IngestionOutcome =
  | 'processed'
  | 'skipped_terminal'
  | 'skipped_not_found'
  | 'skipped_in_flight'
  | 'retry_transient'
  | 'requeue_incomplete';

/**
 * The outcome plus the progress evidence the queue consumer needs to tell a
 * *continuation* (this run advanced durable checkpoints and wants a fresh
 * invocation) apart from a *loop* (this run advanced nothing yet still asks to
 * continue). Only the former may bypass the delivery retry budget — see
 * `MAX_JOB_CONTINUATIONS`.
 */
export interface IngestionRunResult {
  outcome: IngestionOutcome;
  /**
   * Chunks committed during THIS invocation, summed across the job's sources.
   * Every one of them corresponds to durable state: either a source marked
   * `completed` or an advanced `ingest_next_sequence` checkpoint. Zero means the
   * invocation produced no forward progress.
   */
  chunksProcessed: number;
}

export interface ProcessIngestionDeps {
  db: Database;
  llm: LLM;
  embedder: Embedder;
  vectorStore: VectorStore;
  logger: Logger;
  /**
   * Analytics Engine dataset for outcome metrics. Optional — unbound in local
   * dev / tests, where `createMetrics` degrades to a no-op.
   */
  analytics?: AnalyticsEngineDataset;
  /** Deployment environment, used as a metrics tag. */
  environment?: string;
  /** Cloudflare Worker version id, truncated by `createMetrics`. */
  version?: string;
  /** Cloudflare custom-spans surface; omitted in local dev and unit tests. */
  tracing?: TraceProvider;
}

function isRetryable(err: unknown): boolean {
  if (err instanceof LLMRequestError) return err.retryable;
  if (err instanceof EmbeddingRequestError) return err.retryable;
  // Any vector store (Qdrant, Vectorize, …) surfaces failures as VectorStoreError
  // with a `retryable` flag (429/5xx/timeout). Branching on the PORT error — not a
  // single adapter's type — means a Vectorize upsert failure is re-queued, not
  // silently dropped, exactly like a Qdrant one. See issue #4.
  if (err instanceof VectorStoreError) return err.retryable;
  return false;
}

function failureFields(err: unknown): {
  error_category: 'external_service' | 'internal';
  dependency: 'llm' | 'embedding' | 'vector' | 'pipeline';
} {
  if (err instanceof LLMRequestError) {
    return { error_category: 'external_service', dependency: 'llm' };
  }
  if (err instanceof EmbeddingRequestError) {
    return { error_category: 'external_service', dependency: 'embedding' };
  }
  if (err instanceof VectorStoreError) {
    return { error_category: 'external_service', dependency: 'vector' };
  }
  return { error_category: 'internal', dependency: 'pipeline' };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Thrown to unwind a source that is being cancelled mid-chunk. Not a failure:
 * it must not be retried, must not mark the source `failed`, and must not
 * count toward the outcome's error category. The outer loop's next stop check
 * turns it into the ordinary cancellation path.
 */
class IngestionCancelledError extends Error {
  constructor() {
    super('Ingestion cancelled mid-source');
    this.name = 'IngestionCancelledError';
  }
}

/**
 * Emit the terminal `ingestion_outcome` metric. Best-effort: `createMetrics`
 * is a no-op when ANALYTICS is unbound and never throws, so this never affects
 * control flow.
 */
function emitOutcomeMetric(
  deps: ProcessIngestionDeps,
  outcome: {
    finalStatus: IngestionJobStatus;
    durationMs: number;
    failedSourceCount: number;
    tokenCount: number;
    errorCategory?: string;
  },
): void {
  createMetrics(deps.analytics, {
    service: 'ingestion',
    environment: deps.environment,
    version: deps.version,
  }).count('ingestion_outcome', {
    tags: [outcome.finalStatus, outcome.errorCategory],
    values: [outcome.durationMs, outcome.failedSourceCount, outcome.tokenCount],
    index: 'ingestion_outcome',
  });
}

export async function processIngestion(
  msg: IngestionJobMessage,
  deps: ProcessIngestionDeps,
): Promise<IngestionRunResult> {
  const run = () => processIngestionRun(msg, deps);
  if (!deps.tracing) return run();
  return deps.tracing.enterSpan('ingestion.job_total', async (span) => {
    span.setAttribute('crosmos.source_count', msg.source_ids.length);
    try {
      const result = await run();
      span.setAttribute('crosmos.outcome', result.outcome);
      span.setAttribute('crosmos.chunks_processed', result.chunksProcessed);
      return result;
    } catch (error) {
      span.setAttribute('crosmos.outcome', 'failed');
      throw error;
    }
  });
}

async function processIngestionRun(
  msg: IngestionJobMessage,
  deps: ProcessIngestionDeps,
): Promise<IngestionRunResult> {
  const { db, llm, embedder, vectorStore, logger } = deps;
  const metrics = createMetrics(deps.analytics, {
    service: 'ingestion',
    environment: deps.environment,
    version: deps.version,
  });
  const jobStart = performance.now();
  const scope: TenantScope = {
    orgId: msg.org_id,
    spaceId: msg.space_id,
    userId: msg.user_id,
  };

  // Idempotency gate 1 — atomically claim the job. This single CAS subsumes the
  // old "read status, then write processing" sequence: it rejects terminal jobs
  // (redelivery / the other trigger already finished) AND jobs another trigger
  // is actively running (live lease), while still recovering jobs abandoned
  // mid-run (expired lease). Only a `claimed` result means we may proceed.
  const claim = await claimJob(db, msg.job_id, JOB_LEASE_MS);
  if (claim !== 'claimed') {
    logger.info('ingestion.job_claim_skipped', { reason: claim });
    if (claim === 'not_found') return { outcome: 'skipped_not_found', chunksProcessed: 0 };
    if (claim === 'in_flight') return { outcome: 'skipped_in_flight', chunksProcessed: 0 };
    return { outcome: 'skipped_terminal', chunksProcessed: 0 };
  }

  logger.info('ingestion.job_started', {
    source_count: msg.source_ids.length,
  });

  const failedSourceIds: number[] = [];
  const newlyFailedSourceIds: number[] = [];
  const sourceErrors: Record<string, string> = {};
  const results: IngestResult[] = [];
  // Sources that failed on a RETRYABLE infrastructure error (e.g. a red vector
  // store). These are deliberately NOT marked terminally `failed` — they're left
  // `processing` so the re-queue (return 'retry_transient') reprocesses them.
  const transientFailedIds: number[] = [];
  // Representative error category for the rolled-up outcome metric. An external
  // (LLM/embedder) failure dominates over an internal one for alerting.
  let rolledUpErrorCategory: 'external_service' | 'internal' | undefined;
  // Per-invocation chunk budget bookkeeping (issue #2): cumulative chunks of the
  // sources COMPLETED this invocation, and whether we stopped early on budget.
  let chunksProcessed = 0;
  let budgetHit = false;
  // Mid-source lease heartbeat clock (issue #1). Seeded at claim time.
  let lastHeartbeatMs = Date.now();

  /**
   * Should this run stop? Two independent reasons, checked together at every
   * boundary:
   *
   *  - the job was cancelled (explicitly, or by a space delete); and
   *  - the space was tombstoned (deferred deletion), which cancellation should
   *    also have covered but is a separate row and can race.
   *
   * Fails OPEN on a database error: a transient blip must not silently abandon
   * ingestion. Both signals are durable, so the next boundary re-checks.
   */
  const shouldStop = async (): Promise<'cancelled' | 'space_deleted' | null> => {
    try {
      if (await isJobCancelled(db, msg.job_id)) return 'cancelled';
      if (!(await isSpaceActive(db, msg.space_id))) return 'space_deleted';
      return null;
    } catch (err) {
      logger.warn('ingestion.stop_check_failed', {}, err);
      return null;
    }
  };

  for (let i = 0; i < msg.source_ids.length; i++) {
    const sourceId = msg.source_ids[i]!;

    // Stop check between sources — cancellation or a tombstoned space.
    const stopReason = await shouldStop();
    if (stopReason !== null) {
      const remaining = msg.source_ids.slice(i);
      logger.info('ingestion.job_cancelled_mid_run', {
        reason: stopReason,
        completed_source_count: i,
        cancelled_count: remaining.length,
        source_count: msg.source_ids.length,
      });

      // Bill the INPUT tokens of the sources completed before the cancel — the
      // quota meters submitted content, not pipeline throughput. Completed
      // sources won't be reprocessed (gate 2), so there's no double-count.
      // `throughputTokens` (LLM + embedder) is the provider cost, reported to
      // the outcome metric below — not the quota.
      const throughputTokens = llm.totalTokens + embedder.totalTokens;
      const inputTokens = results.reduce((n, r) => n + r.tokenCount, 0);
      if (results.length > 0) {
        try {
          await recordIngestionUsage(db, scope, {
            tokens: inputTokens,
            completedSourceIds: results.map((result) => result.sourceId),
            failedSourceIds: newlyFailedSourceIds,
          });
        } catch (err) {
          logger.warn('ingestion.record_tokens_failed', {}, err);
        }
      }

      // Drive the still-non-terminal (unprocessed) sources to a TERMINAL state
      // so source-status reads and monitoring don't show them stuck `pending`
      // forever. The helper only transitions `pending`/`processing` rows, so a
      // source a PRIOR run already completed keeps its real status. There is no
      // `cancelled` value in the extraction-status enum, so it uses the closest
      // terminal state (`failed`) plus a reason in `meta`.
      if (remaining.length > 0) {
        try {
          await markUnprocessedSourcesCancelled(
            db,
            scope,
            remaining,
            'Ingestion job cancelled before this source was processed',
          );
        } catch (err) {
          logger.warn('ingestion.cancel_mark_sources_failed', {}, err);
        }
      }

      emitOutcomeMetric(deps, {
        finalStatus: 'cancelled',
        durationMs: durationMs(jobStart),
        failedSourceCount: remaining.length,
        tokenCount: throughputTokens,
      });

      // We owned the job; cancellation is a terminal outcome for this delivery.
      return { outcome: 'processed', chunksProcessed };
    }

    // Per-invocation chunk budget (issues #2 / #9). Once we've processed a full
    // invocation's worth of chunks, stop and re-queue: the remaining sources —
    // and any unfinished batch of a large source, tracked by its durable
    // checkpoint — continue in a fresh invocation. Checked BEFORE claiming or
    // marking this source so an untouched source stays exactly as it was.
    if (chunksProcessed >= MAX_CHUNKS_PER_INVOCATION) {
      logger.info('ingestion.invocation_budget_reached', {
        chunks_processed: chunksProcessed,
        remaining_source_count: msg.source_ids.length - i,
      });
      budgetHit = true;
      break;
    }

    // Idempotency gate 2 — only skip sources that reached a TERMINAL state.
    // Crucially, `processing` is NOT terminal: it marks a source left mid-flight
    // by a previous run that died (isolate eviction) and was reclaimed here via
    // the job lease. The old code skipped it, orphaning the source forever — so
    // we re-process it instead. `ingestSource` purges any partial artifacts up
    // front, so re-running is safe (no duplicate memories/vectors). The job-level
    // lease guarantees only one live run owns this job, and the LLM/embedder
    // timeouts make a wedged prior run resolve well before the lease expires, so
    // we aren't racing a concurrent processor.
    const sourceStatus = await getSourceExtractionStatus(db, sourceId);
    if (sourceStatus !== 'pending' && sourceStatus !== 'processing') {
      logger.info('ingestion.source_already_processed', {
        source_id: sourceId,
        status: sourceStatus,
      });
      if (sourceStatus === 'failed') failedSourceIds.push(sourceId);
      continue;
    }

    // Per-source progress write — this is ALSO the lease heartbeat: it
    // re-stamps `started_at`, keeping the queue backstop from reclaiming a job
    // that's still making progress. Keep it inside the loop. See `claimJob` and
    // the load-bearing note in `updateJobStatus`.
    await updateJobStatus(db, msg.job_id, 'processing', {
      stage: `source ${i + 1}/${msg.source_ids.length}`,
    });
    await markSourcesStatus(db, scope, [sourceId], 'processing');
    const sourceLogger = logger.child({ source_id: sourceId });
    const sourceStart = performance.now();
    sourceLogger.info('ingestion.source_started', {
      stage: `source ${i + 1}/${msg.source_ids.length}`,
    });

    // The per-source status write above is itself a lease beat, so reset the
    // clock: the mid-source heartbeat only fires when a SINGLE source runs long
    // (issue #1). Throttled to at most one DB write per CHUNK_HEARTBEAT_INTERVAL_MS
    // and best-effort — a missed beat only risks a (recoverable) re-claim.
    lastHeartbeatMs = Date.now();
    const heartbeat = async () => {
      const now = Date.now();
      if (now - lastHeartbeatMs < CHUNK_HEARTBEAT_INTERVAL_MS) return;
      lastHeartbeatMs = now;
      try {
        // The heartbeat is now also the mid-source CANCELLATION DETECTOR.
        // `updateJobStatus` is compare-and-set on terminality, so a job the API
        // cancelled refuses the write — and that refusal is the signal. This
        // gives a long multi-chunk source a cancellation checkpoint without
        // adding a query: previously the only checks were between sources, so a
        // single large source could run to completion inside a space the user
        // had already deleted.
        const applied = await updateJobStatus(db, msg.job_id, 'processing', {
          stage: `source ${i + 1}/${msg.source_ids.length} (in progress)`,
        });
        if (!applied) {
          sourceLogger.info('ingestion.source_cancelled_mid_chunk', {
            source_id: sourceId,
            reason: 'cancelled',
          });
          throw new IngestionCancelledError();
        }
      } catch (err) {
        if (err instanceof IngestionCancelledError) throw err;
        sourceLogger.warn('ingestion.heartbeat_failed', {}, err);
      }
    };

    let result: IngestResult | null = null;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= SOURCE_RETRY_ATTEMPTS; attempt++) {
      try {
        const ingestAttempt = () => ingestSource({
          db,
          scope,
          sourceId,
          llm,
          embedder,
          vectorStore,
          logger: sourceLogger,
          metrics,
          tracing: deps.tracing,
          heartbeat,
          // Max NEW chunks this source may process this invocation — the
          // remaining invocation budget. `ingestSource` resumes from the source's
          // durable checkpoint, processes at most this many chunks, and reports
          // any remainder for continuation on a re-queue (issue #9).
          chunkBudgetRemaining: MAX_CHUNKS_PER_INVOCATION - chunksProcessed,
        });
        result = deps.tracing
          ? await deps.tracing.enterSpan('ingestion.source_total', async (span) => {
              span.setAttribute('crosmos.attempt', attempt);
              try {
                const sourceResult = await ingestAttempt();
                span.setAttribute('crosmos.outcome', 'ok');
                span.setAttribute(
                  'crosmos.chunks_processed',
                  sourceResult.processedChunkCount,
                );
                return sourceResult;
              } catch (error) {
                span.setAttribute('crosmos.outcome', 'failed');
                throw error;
              }
            })
          : await ingestAttempt();
        break;
      } catch (err) {
        lastErr = err;
        // A cancellation is not a failure — stop immediately rather than
        // burning the retry budget on work that is being torn down.
        if (err instanceof IngestionCancelledError) break;
        if (isRetryable(err) && attempt < SOURCE_RETRY_ATTEMPTS) {
          sourceLogger.warn('ingestion.source_retry_scheduled', {
            attempt,
            duration_ms: durationMs(sourceStart),
            ...failureFields(err),
          });
          await sleep(SOURCE_RETRY_DELAY_MS * attempt);
          continue;
        }
        break;
      }
    }

    if (result) {
      chunksProcessed += result.processedChunkCount;
      if (result.remainingChunkCount > 0) {
        // A large source was only PARTIALLY processed this invocation (its batch
        // budget ran out). It stays `processing` with its checkpoint advanced;
        // re-queue so a fresh invocation continues from there (issue #9). It's
        // neither billed nor counted complete until its final batch lands.
        budgetHit = true;
        sourceLogger.info('ingestion.source_batch_incomplete', {
          duration_ms: durationMs(sourceStart),
          processed_chunk_count: result.processedChunkCount,
          remaining_chunk_count: result.remainingChunkCount,
          chunk_count: result.chunkCount,
        });
        break;
      }
      results.push(result);
      await markSourcesStatus(db, scope, [sourceId], 'completed');
      sourceLogger.info('ingestion.source_completed', {
        duration_ms: durationMs(sourceStart),
        memory_count: result.memories.length,
        edge_count: result.edges.length,
        entity_count: result.newEntityIds.length + result.resolvedEntityIds.length,
      });
    } else if (lastErr instanceof IngestionCancelledError) {
      // Leave the source exactly as it is (`processing`). The stop check at the
      // top of the next iteration runs the normal cancellation path, which
      // drives the remaining sources to a terminal state and bills what
      // completed. Marking it failed here would misreport a cancellation as an
      // ingestion error.
      sourceLogger.info('ingestion.source_cancelled', {
        source_id: sourceId,
        duration_ms: durationMs(sourceStart),
      });
      continue;
    } else {
      const message =
        lastErr instanceof Error ? lastErr.message : String(lastErr);
      const fields = failureFields(lastErr);
      // Retryable infra failure that survived the in-source retry budget = the
      // dependency is (still) degraded. Don't terminally fail the source —
      // leave it `processing` and re-queue the job so it's reprocessed once the
      // dependency recovers, instead of silently dropping the session (#4).
      const transient = isRetryable(lastErr);
      sourceLogger.error('ingestion.source_failed', {
        duration_ms: durationMs(sourceStart),
        error_message: message,
        transient,
        ...fields,
      }, lastErr);
      // An external (LLM/embedder) failure dominates for outcome alerting.
      if (fields.error_category === 'external_service') {
        rolledUpErrorCategory = 'external_service';
      } else if (rolledUpErrorCategory === undefined) {
        rolledUpErrorCategory = 'internal';
      }
      // Lightweight AI-dependency error metric at this clean catch site.
      if (
        lastErr instanceof LLMRequestError ||
        lastErr instanceof EmbeddingRequestError
      ) {
        createMetrics(deps.analytics, {
          service: 'ingestion',
          environment: deps.environment,
          version: deps.version,
        }).count('ingestion_ai_error', {
          tags: [fields.dependency, String(lastErr.status), lastErr.retryable],
          index: 'ingestion_ai_error',
        });
      }
      if (transient) {
        // Leave the source `processing` (gate 2 reprocesses it on the re-run).
        transientFailedIds.push(sourceId);
      } else {
        sourceErrors[String(sourceId)] = message;
        await markSourcesFailed(db, scope, [sourceId], message);
        failedSourceIds.push(sourceId);
        newlyFailedSourceIds.push(sourceId);
      }
    }
  }

  // If any source hit a retryable infra failure, re-queue the whole job rather
  // than recording a terminal status that would lose those sessions. The job is
  // reset to `pending` (CAS-guarded; we own the claim) and the queue consumer
  // re-delivers after a delay — completed sources are skipped on the re-run
  // (gate 2), permanently-failed ones stay failed, and the transient ones are
  // reprocessed once the dependency recovers. Token usage from this aborted
  // attempt is intentionally not recorded here to avoid double-counting against
  // the successful re-run.
  if (transientFailedIds.length > 0) {
    const reset = await resetJobForRetry(db, msg.job_id);
    logger.warn('ingestion.job_retry_transient', {
      duration_ms: durationMs(jobStart),
      transient_source_count: transientFailedIds.length,
      permanent_failed_count: failedSourceIds.length,
      completed_source_count: results.length,
      reset,
    });
    emitOutcomeMetric(deps, {
      finalStatus: 'pending',
      durationMs: durationMs(jobStart),
      failedSourceCount: transientFailedIds.length,
      tokenCount: llm.totalTokens + embedder.totalTokens,
      errorCategory: rolledUpErrorCategory ?? 'external_service',
    });
    return { outcome: 'retry_transient', chunksProcessed };
  }

  // Per-invocation chunk budget exhausted (issue #2). We stopped before all
  // sources were processed; the completed ones are persisted and will be skipped
  // (gate 2) on the re-run, so bill their tokens NOW or lose the attribution —
  // unlike the transient path, nothing here is reprocessed, so there's no
  // double-count risk. Reset the job to `pending` and re-queue so the remaining
  // sources run in a fresh invocation with a full budget. No terminal status is
  // written: the job rolls up only once it actually finishes a full pass.
  if (budgetHit) {
    // Bill the input tokens of the sources completed this invocation; the
    // deferred/remaining sources are billed when they complete on the re-run
    // (gate 2 skips the completed ones, so no double-count). Throughput is the
    // provider cost, reported to the metric below.
    const throughputTokens = llm.totalTokens + embedder.totalTokens;
    const budgetTokens = results.reduce((n, r) => n + r.tokenCount, 0);
    if (results.length > 0 || newlyFailedSourceIds.length > 0) {
      try {
        await recordIngestionUsage(db, scope, {
          tokens: budgetTokens,
          completedSourceIds: results.map((result) => result.sourceId),
          failedSourceIds: newlyFailedSourceIds,
        });
      } catch (err) {
        logger.warn('ingestion.record_tokens_failed', {}, err);
      }
    }
    const reset = await resetJobForRetry(db, msg.job_id);
    logger.info('ingestion.job_requeue_incomplete', {
      duration_ms: durationMs(jobStart),
      chunks_processed: chunksProcessed,
      completed_source_count: results.length,
      permanent_failed_count: failedSourceIds.length,
      reset,
    });
    emitOutcomeMetric(deps, {
      finalStatus: 'pending',
      durationMs: durationMs(jobStart),
      failedSourceCount: failedSourceIds.length,
      tokenCount: throughputTokens,
    });
    return { outcome: 'requeue_incomplete', chunksProcessed };
  }

  // Roll up job status — mirrors Python's `process_ingestion` terminal block.
  const all = msg.source_ids.length;
  const failed = failedSourceIds.length;
  let finalStatus: IngestionJobStatus;
  let rolledUpError: string | undefined;
  if (failed === 0) {
    finalStatus = 'completed';
  } else if (failed === all) {
    finalStatus = 'failed';
    rolledUpError = 'All sources failed during ingestion';
  } else {
    finalStatus = 'partial';
    rolledUpError = `${failed}/${all} sources failed`;
  }

  const memoryCount = results.reduce((n, r) => n + r.memories.length, 0);
  const edgeCount = results.reduce((n, r) => n + r.edges.length, 0);
  // Python counts UNIQUE entity ids across all sources via set union.
  const entityIds = new Set<number>();
  for (const r of results) {
    for (const id of r.newEntityIds) entityIds.add(id);
    for (const id of r.resolvedEntityIds) entityIds.add(id);
  }
  const entityCount = entityIds.size;
  // Provider cost (LLM + embedder throughput) — reported to the outcome metric
  // and job log for COGS observability, but NOT the quota.
  const throughputTokens = llm.totalTokens + embedder.totalTokens;
  // Quota basis: input tokens of the sources that completed. This is what the
  // user submitted, not what the pipeline burned internally.
  const inputTokens = results.reduce((n, r) => n + r.tokenCount, 0);

  // Best-effort token recording — failure does not fail the job (Python
  // wraps this in try/except too).
  if (results.length > 0 || newlyFailedSourceIds.length > 0) {
    try {
      await recordIngestionUsage(db, scope, {
        tokens: inputTokens,
        completedSourceIds: results.map((result) => result.sourceId),
        failedSourceIds: newlyFailedSourceIds,
      });
    } catch (err) {
      logger.warn('ingestion.record_tokens_failed', {}, err);
    }
  }

  const resultBody: IngestionJobResult = {
    // Python reports the original source_ids (not just completed) so callers
    // can reconstruct the input batch from the result payload.
    source_ids: msg.source_ids,
    failed_source_ids: failedSourceIds,
    memory_count: memoryCount,
    entity_count: entityCount,
    edge_count: edgeCount,
    // User-facing usage == the quota basis (submitted input tokens).
    tokens_used: inputTokens,
  };
  if (Object.keys(sourceErrors).length > 0) resultBody.source_errors = sourceErrors;
  if (rolledUpError) resultBody.error_message = rolledUpError;

  await updateJobStatus(db, msg.job_id, finalStatus, { result: resultBody });
  logger.info('ingestion.job_completed', {
    duration_ms: durationMs(jobStart),
    final_status: finalStatus,
    source_count: all,
    failed_source_count: failed,
    memory_count: memoryCount,
    entity_count: entityCount,
    edge_count: edgeCount,
    token_count: throughputTokens,
    input_token_count: inputTokens,
  });
  emitOutcomeMetric(deps, {
    finalStatus,
    durationMs: durationMs(jobStart),
    failedSourceCount: failed,
    tokenCount: throughputTokens,
    errorCategory: failed > 0 ? rolledUpErrorCategory : undefined,
  });
  return { outcome: 'processed', chunksProcessed };
}
