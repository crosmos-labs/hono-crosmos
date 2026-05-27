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
import { durationMs, type Logger } from '@crosmos/observability';
import type {
  IngestionJobMessage,
  IngestionJobResult,
  IngestionJobStatus,
  TenantScope,
} from '@crosmos/types';
import {
  SOURCE_RETRY_ATTEMPTS,
  SOURCE_RETRY_DELAY_MS,
} from './constants';
import type { Embedder } from './integrations/embeddings';
import { EmbeddingRequestError } from './integrations/embeddings';
import type { LLM } from './integrations/llm';
import { LLMRequestError } from './integrations/llm';
import { ingestSource, type IngestResult } from './ingestion/pipeline';
import {
  getJobStatus,
  isJobCancelled,
  updateJobStatus,
} from './job-store';
import {
  getSourceExtractionStatus,
  markSourcesFailed,
  markSourcesStatus,
} from './source-status';
import { recordIngestionTokens } from './usage';

const TERMINAL_STATUSES: ReadonlySet<IngestionJobStatus> = new Set([
  'completed',
  'partial',
  'failed',
  'cancelled',
]);

export interface ProcessIngestionDeps {
  db: Database;
  llm: LLM;
  embedder: Embedder;
  logger: Logger;
}

function isRetryable(err: unknown): boolean {
  if (err instanceof LLMRequestError) return err.retryable;
  if (err instanceof EmbeddingRequestError) return err.retryable;
  return false;
}

function failureFields(err: unknown): {
  error_category: 'external_service' | 'internal';
  dependency: 'llm' | 'embedding' | 'pipeline';
} {
  if (err instanceof LLMRequestError) {
    return { error_category: 'external_service', dependency: 'llm' };
  }
  if (err instanceof EmbeddingRequestError) {
    return { error_category: 'external_service', dependency: 'embedding' };
  }
  return { error_category: 'internal', dependency: 'pipeline' };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function processIngestion(
  msg: IngestionJobMessage,
  deps: ProcessIngestionDeps,
): Promise<void> {
  const { db, llm, embedder, logger } = deps;
  const jobStart = performance.now();
  const scope: TenantScope = {
    orgId: msg.org_id,
    spaceId: msg.space_id,
    userId: msg.user_id,
  };

  // Idempotency gate 1 — terminal jobs are no-ops on redelivery
  const initial = await getJobStatus(db, msg.job_id);
  if (initial === null) {
    logger.warn('ingestion.job_not_found');
    return;
  }
  if (TERMINAL_STATUSES.has(initial)) {
    logger.info('ingestion.job_already_terminal', {
      status: initial,
    });
    return;
  }

  await updateJobStatus(db, msg.job_id, 'processing');
  logger.info('ingestion.job_started', {
    source_count: msg.source_ids.length,
  });

  const failedSourceIds: number[] = [];
  const sourceErrors: Record<string, string> = {};
  const results: IngestResult[] = [];

  for (let i = 0; i < msg.source_ids.length; i++) {
    const sourceId = msg.source_ids[i]!;

    // Cancellation check between sources
    if (await isJobCancelled(db, msg.job_id)) {
      logger.info('ingestion.job_cancelled_mid_run', {
        completed_source_count: i,
        source_count: msg.source_ids.length,
      });
      return;
    }

    // Idempotency gate 2 — source already past pending → skip
    const sourceStatus = await getSourceExtractionStatus(db, sourceId);
    if (sourceStatus !== 'pending') {
      logger.info('ingestion.source_already_processed', {
        source_id: sourceId,
        status: sourceStatus,
      });
      if (sourceStatus === 'failed') failedSourceIds.push(sourceId);
      continue;
    }

    await updateJobStatus(db, msg.job_id, 'processing', {
      stage: `source ${i + 1}/${msg.source_ids.length}`,
    });
    await markSourcesStatus(db, scope, [sourceId], 'processing');
    const sourceLogger = logger.child({ source_id: sourceId });
    const sourceStart = performance.now();
    sourceLogger.info('ingestion.source_started', {
      stage: `source ${i + 1}/${msg.source_ids.length}`,
    });

    let result: IngestResult | null = null;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= SOURCE_RETRY_ATTEMPTS; attempt++) {
      try {
        result = await ingestSource({
          db,
          scope,
          sourceId,
          llm,
          embedder,
          logger: sourceLogger,
        });
        break;
      } catch (err) {
        lastErr = err;
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
      results.push(result);
      await markSourcesStatus(db, scope, [sourceId], 'completed');
      sourceLogger.info('ingestion.source_completed', {
        duration_ms: durationMs(sourceStart),
        memory_count: result.memories.length,
        edge_count: result.edges.length,
        entity_count: result.newEntityIds.length + result.resolvedEntityIds.length,
      });
    } else {
      const message =
        lastErr instanceof Error ? lastErr.message : String(lastErr);
      sourceLogger.error('ingestion.source_failed', {
        duration_ms: durationMs(sourceStart),
        error_message: message,
        ...failureFields(lastErr),
      }, lastErr);
      sourceErrors[String(sourceId)] = message;
      await markSourcesFailed(db, scope, [sourceId], message);
      failedSourceIds.push(sourceId);
    }
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
  const totalTokens = llm.totalTokens + embedder.totalTokens;

  // Best-effort token recording — failure does not fail the job (Python
  // wraps this in try/except too).
  if (totalTokens > 0) {
    try {
      await recordIngestionTokens(db, scope, totalTokens);
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
    tokens_used: totalTokens,
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
    token_count: totalTokens,
  });
}
