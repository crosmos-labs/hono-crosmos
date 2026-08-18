import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { createApiApp } from '../../lib/openapi';
import { users } from '@crosmos/db';
import { EmbeddingRequestError, RerankerRequestError } from '@crosmos/ai';
import {
  createLogger,
  createMetrics,
  createStageRecorder,
  durationMs,
  type TraceProvider,
} from '@crosmos/observability';
import { inArray } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import type { HonoEnv } from '../../bindings';
import { getApiConfig } from '../../config';
import { getDb } from '../../db';
import {
  enforcePlanRateLimit,
  getRateLimiter,
  RateLimitError,
} from '../../integrations/rate-limit';
import { checkGlobalAiThrottle } from '../../integrations/rate-limit/global-ai';
import { getEmbedder } from '../../integrations/embeddings';
import { getReranker } from '../../integrations/reranker';
import { getVectorStore } from '../../integrations/vector-store';
import type { TenantScope } from '../../lib/scope';
import { requireAuth } from '../auth/middleware';
import { requirePrincipal } from '../auth/principal';
import { assertKeyScopeAllowsSpace } from '../../lib/key-scope';
import { checkQuota, QuotaExceededError } from '../orgs/entitlements';
import { getCachedEntitlements, getCachedSpaceByUuid } from '../../lib/gate-cache';
import { getBackgroundTasks } from '../../lib/runtime';
import { recordSearchQueries } from '../usage/service';
import { resolveReadVisibility } from '../visibility/service';
import { attachSourceContent, touchMemories } from './candidates';
import { getConcurrencyLimiter } from './concurrency';
import {
  CANDIDATE_POOL,
  GLOBAL_AI_RETRY_AFTER_SECONDS,
  GLOBAL_AI_WINDOW_SECONDS,
  RETRIEVAL_RETRY_AFTER_SECONDS,
} from './constants';
import { getOperationalLimits } from '../../lib/limits';
import {
  NO_RETRY_HEADERS,
  noRetryUntilHeaders,
  retryAfterHeaders,
} from '../../lib/retry-hints';
import { classifyDependencyError } from '../../lib/dependency-errors';
import { SearchRequestSchema, SearchResponseSchema } from './schemas';
import { awaitSearchAdmission } from './admission';
import { retrieve } from './service';
import type { CandidateMemory, RetrievalResult } from './types';

export const searchRoutes = createApiApp();

const ErrorBody = z.object({ detail: z.unknown() }).openapi('SearchErrorBody');

class TimeoutError extends Error {}

function failureFields(err: unknown): {
  error_category: 'external_service' | 'internal';
  dependency: 'embedding' | 'reranker' | 'retrieval';
} {
  if (err instanceof EmbeddingRequestError) {
    return { error_category: 'external_service', dependency: 'embedding' };
  }
  if (err instanceof RerankerRequestError) {
    return { error_category: 'external_service', dependency: 'reranker' };
  }
  return { error_category: 'internal', dependency: 'retrieval' };
}

function jsonError(
  detail: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ detail }), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/**
 * Reject after `ms`, and ABORT the work rather than merely stop awaiting it.
 *
 * Racing a timer against a promise ends the wait but not the work. Every
 * downstream call — the query embedding, the Qdrant searches, the reranker —
 * kept running to completion on a request the client had already been told
 * timed out, holding provider and connection capacity the whole time. During an
 * overload that invisible work is self-sustaining: the capacity it consumes is
 * exactly the capacity the next request needs.
 *
 * `controller` is handed to `retrieve` so cancellable calls are aborted and
 * later stages are skipped. It is also aborted on the SUCCESS path, in a
 * `finally`, so any fire-and-forget work started during the request (a
 * fail-soft auxiliary signal still in flight when the essential ones finished)
 * does not outlive the response.
 */
function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  controller: AbortController,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort(new TimeoutError());
      reject(new TimeoutError());
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

interface SearchCandidateOut {
  memory_id: string;
  content: string;
  memory_type: string;
  score: number;
  source?: string | null;
  created_at: string;
  event_time: string | null;
  owner_name: string | null;
}

function buildResponse(
  ownerById: Map<number, string>,
  queryText: string,
  result: RetrievalResult,
  includeSource: boolean,
): {
  query: string;
  candidates: SearchCandidateOut[];
} {
  const raw = result.candidates;
  if (raw.length === 0) {
    return { query: queryText, candidates: [] };
  }

  const candidates: SearchCandidateOut[] = raw.map((c: CandidateMemory) => {
    const out: SearchCandidateOut = {
      // Each result candidate carries its own uuid (hydrated with the row). Fall
      // back to the raw int (as Python does) if it is somehow missing.
      memory_id: c.uuid ?? String(c.memoryId),
      content: c.content,
      memory_type: c.memoryType,
      score: c.finalScore,
      created_at: c.createdAt.toISOString(),
      event_time: c.eventTime ? c.eventTime.toISOString() : null,
      owner_name: c.ownerUserId != null ? ownerById.get(c.ownerUserId) ?? null : null,
    };
    // include_source=true → key present (value may be null); false → omit key.
    if (includeSource) out.source = c.sourceChunk ?? null;
    return out;
  });

  return { query: queryText, candidates };
}

// POST /api/v1/search — hybrid retrieval, run inline (decisions.md §1).
searchRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['search'],
    summary: 'Search Memories',
    description:
      'Search for relevant memories within a memory space using hybrid retrieval (semantic + keyword + graph + temporal), RRF fusion, cross-encoder reranking, and recency/temporal boosting.',
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth, requirePrincipal] as const,
    request: {
      body: {
        content: { 'application/json': { schema: SearchRequestSchema } },
      },
    },
    responses: {
      200: {
        description: 'Ranked memory candidates',
        content: { 'application/json': { schema: SearchResponseSchema } },
      },
      401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorBody } } },
      404: { description: 'Space not found', content: { 'application/json': { schema: ErrorBody } } },
      429: {
        description: 'Rate limited, quota exceeded, or too many concurrent searches',
        content: { 'application/json': { schema: ErrorBody } },
      },
      504: { description: 'Search timed out', content: { 'application/json': { schema: ErrorBody } } },
      500: { description: 'Unexpected failure', content: { 'application/json': { schema: ErrorBody } } },
    },
  }),
  async (c) => {
    const requestStarted = performance.now();
    const body = c.req.valid('json');
    const db = getDb(c);
    const limits = getOperationalLimits(c.env);
    const orgId = c.var.activeOrgId!;
    const userId = c.var.userId!;
    const requestId = c.var.requestId ?? crypto.randomUUID();
    const logger = createLogger({
      service: 'api',
      environment: c.env.ENVIRONMENT,
      base: {
        request_id: requestId,
        org_id: orgId,
        user_id: userId,
        // Structured logs only. Never a metric tag: this is caller-supplied and
        // unbounded in cardinality, so tagging on it would blow up the metrics
        // sink. Correlates retries of one logical recall across request ids.
        ...(body.recall_id ? { recall_id: body.recall_id } : {}),
      },
    });
    logger.info('retrieval.request_started', {
      query_length: body.query.length,
      top_k: body.limit,
      graph_enabled: body.graph,
    });

    // Lightweight metrics emitter (no-op if ANALYTICS unbound; never throws).
    const metrics = createMetrics(c.env.ANALYTICS, {
      service: 'api',
      environment: c.env.ENVIRONMENT,
      version: c.env.CF_VERSION_METADATA?.id,
    });
    const tracing = (
      c.executionCtx as ExecutionContext & { tracing?: TraceProvider }
    ).tracing;
    const stages = createStageRecorder({
      logger,
      metrics,
      tracing,
      event: 'retrieval.stage_completed',
      metric: 'api_stage',
    });
    const recordThrottle = (
      reason: 'concurrency' | 'plan_rate_limit' | 'monthly_quota' | 'global_ai',
      observedCount = -1,
      configuredLimit = -1,
    ) => {
      metrics.count('search_throttled', {
        // blob5: reason. doubles: request duration at rejection, observed
        // count/depth, configured limit. -1 means the limiter does not expose
        // that value (currently the concurrency lease).
        tags: [reason],
        values: [durationMs(requestStarted), observedCount, configuredLimit],
        index: 'search',
      });
    };

    // KV writes commit cross-region (~350ms from this Smart-Placed worker), so
    // the rate-limit + concurrency counters push their writes here instead of
    // blocking the response. The worker stays alive until they settle.
    const defer = (task: Promise<unknown>) => getBackgroundTasks(c).waitUntil(task);

    return stages.time('search_total', {}, async () => {

    // ── GATE 1: per-user overload shedding ───────────────────────────────────
    //
    // This runs FIRST, immediately after authentication has established the
    // principal, and deliberately before any database- or KV-backed work.
    //
    // It used to run last, after entitlements, space access, the plan limiter
    // and the monthly quota. During the 2026-07-25 incident that meant every one
    // of the 10,757 rejected searches first performed two KV reads, up to four
    // rate-limiter round-trips and a quota query before being told no — 128ms
    // average wall time and 7.17ms CPU each, spent entirely on work that was
    // then discarded. Shedding here makes a rejection one Durable Object call.
    //
    // Safe to hoist because the gate keys ONLY on `userId`, which `requirePrincipal`
    // has already established. It is a coarse per-principal backpressure valve,
    // not an authorization decision: space authorization, the plan limit and the
    // quota are all still enforced below for everything that gets admitted, and
    // rejecting here reveals nothing about whether a space exists. It also means
    // a shed request no longer consumes monthly AI quota it never used.
    // One deadline for the whole request. Declared out here so the `finally`
    // below can abort it on EVERY exit path, not just the timeout one.
    const deadline = new AbortController();
    const concurrency = getConcurrencyLimiter(c.env, defer);
    const userKey = String(userId);
    const lease = await stages.time(
      'concurrency_acquire',
      {},
      () =>
        concurrency.acquire(
          userKey,
          limits.retrievalMaxConcurrentPerUser,
          limits.retrievalSlotTtlSeconds,
          // Optional caller-supplied identity for one LOGICAL recall. Retries of
          // the same search reuse a single slot rather than each consuming one —
          // during the 2026-07-25 incident, retried copies of the same recall
          // competing for the very slot they were waiting on were 52.98% of all
          // search invocations. Omitted by clients that don't send it, which
          // leaves behavior exactly as before.
          body.recall_id,
        ),
    );
    if (!lease.acquired) {
      logger.warn('retrieval.request_rejected', {
        stage: 'concurrency_acquire',
        status_code: 429,
      });
      recordThrottle(
        'concurrency',
        -1,
        limits.retrievalMaxConcurrentPerUser,
      );
      // `Retry-After` (never sent before this fix) is what stops the SDK from
      // retrying INSTANTLY. A concurrency 429 means this user's own in-flight
      // work has not drained yet, so an immediate retry is guaranteed to find
      // the same full counter AND adds a fresh request competing for the slot
      // it is waiting on. In the incident this class alone was 52.98% of all
      // search invocations. `RETRIEVAL_RETRY_AFTER_SECONDS` has existed as a
      // constant since the Python port but was never actually wired to a
      // response until now.
      throw new HTTPException(429, {
        res: jsonError(
          'Too many concurrent searches. Wait for existing searches to complete.',
          429,
          retryAfterHeaders(RETRIEVAL_RETRY_AFTER_SECONDS),
        ),
      });
    }

    // Start the only query-dependent provider call as soon as overload
    // shedding admits the request. Authorization, entitlement, quota and the
    // global AI throttle still gate the response below, but their I/O now
    // overlaps the embedding instead of sitting wholly in front of it. The
    // request-wide controller is aborted in `finally`, so a later gate failure
    // cancels an embedding that is still in flight.
    //
    // Deliberate tradeoff: a request rejected by a later 404/429 can consume one
    // embedding call. Authentication and the per-user concurrency shield have
    // already passed, bounding that exposure; no retrieval result or protected
    // data is available to the embedder.
    const embedder = getEmbedder(c.env);
    const embedPromise = stages.span(
      'retrieval_query_embedding',
      () => embedder.embed(body.query, {
        mode: 'search',
        signal: deadline.signal,
      }),
    );
    // retrieve() awaits this on the success path. Guard the pre-await window so
    // provider rejection while admission is running is not reported as an
    // unhandled promise rejection.
    embedPromise.catch(() => {});

    // Wall-clock for the RETRIEVAL phase only. Reassigned once the gates are
    // done so `retrieval.request_completed.duration_ms` keeps exactly the
    // meaning it had before admission was reordered — otherwise the before/after
    // latency comparison for this rollout would be against a moved goalpost.
    // Seeded here so an unexpected failure during admission still logs a
    // sensible duration.
    let t0 = performance.now();
    // `space` is needed by the failure logs in `catch`, but is only resolved
    // partway through the block; `undefined` until then.
    let spaceId: number | undefined;

    try {
      // ── GATE 2 onwards: authorization, entitlement and quota ─────────────────
      // Entitlements + space access are independent, side-effect-free KV reads, so
      // fetch them CONCURRENTLY. On a cold isolate each KV read is ~150-200ms;
      // serialized they dominated gate latency. Entitlements is shared with the
      // rate-limit gate, the quota gate, and the orchestrator (was 3 fetches); the
      // space check guarantees space.orgId === orgId so the entitlements apply
      // throughout. The remaining gates (rate-limit → quota) stay ordered because
      // they have side effects (counter increments) whose sequencing is
      // semantically meaningful.
      const [entitlements, space] = await Promise.all([
        stages.time('entitlements', {},
          () => getCachedEntitlements(c, orgId)),
        stages.time('space_access', {},
          () => getCachedSpaceByUuid(c, body.space_id)),
      ]);
      // Authoritative org is the SPACE's org. 404 on missing or cross-tenant (no
      // existence leak).
      if (!space || space.orgId !== orgId) {
        logger.warn('retrieval.request_rejected', {
          stage: 'space_access',
          status_code: 404,
        });
        throw new HTTPException(404, {
          res: jsonError(`Space ${body.space_id} not found`, 404),
        });
      }
      // A space-scoped API key may only search its pinned space (no-op otherwise).
      assertKeyScopeAllowsSpace(c, space.id);
      spaceId = space.id;

      // 2. Per-org plan rate limit (the STRICT AI-path limit, 10 RPM on free).
      //
      // `requireAuth` only applies the looser management limit, so this is where
      // the AI budget is actually enforced for search. It reuses the entitlements
      // already loaded above and defers its counter writes so search latency stays
      // the priority. The reads (edge-cached, fast) still gate synchronously. The
      // `planRateLimitEnforced` guard stays for idempotency. Tradeoff: under high
      // concurrency the per-org cap can admit a few extra requests at the boundary
      // (the ±1-2 fuzz the KV limiter design accepts, decisions.md §7); the coarse
      // per-org RPM cap (10 free / 300 pro) doesn't need exact enforcement, and the
      // global-AI throttle below is what actually bounds aggregate AI cost.
      const shouldEnforcePlan = !c.var.planRateLimitEnforced;
      const planCheck = shouldEnforcePlan
        ? stages.time('plan_rate_limit', {}, () =>
            enforcePlanRateLimit(db, getRateLimiter(c.env, defer), orgId, entitlements))
        : Promise.resolve();
      // Monthly quota is independent of the plan limiter. Start both reads
      // together, but inspect the settled plan result first so the outward
      // error precedence and counter-consumption contract remain unchanged.
      // No embedder/provider work starts until both have fulfilled.
      const quotaCheck = stages.time('monthly_quota', {
        space_id: space.id,
      }, () => checkQuota(db, space.orgId, 'monthly_search_queries', 1, entitlements));
      const admission = await awaitSearchAdmission(planCheck, quotaCheck);

      if (!admission.accepted && admission.stage === 'plan_rate_limit') {
        const err = admission.reason;
        if (err instanceof RateLimitError) {
          logger.warn('retrieval.request_rejected', {
            stage: 'plan_rate_limit',
            status_code: 429,
          });
          recordThrottle('plan_rate_limit', err.count, err.limit);
          throw new HTTPException(429, {
            res: jsonError(
              { error: 'rate_limited', scope: err.scope, limit: err.limit, count: err.count },
              429,
              { 'Retry-After': String(err.retryAfterSeconds) },
            ),
          });
        }
        throw err;
      }
      if (shouldEnforcePlan) c.set('planRateLimitEnforced', true);

      if (!admission.accepted && admission.stage === 'monthly_quota') {
        const err = admission.reason;
        if (err instanceof QuotaExceededError) {
          logger.warn('retrieval.request_rejected', {
            stage: 'monthly_quota',
            status_code: 429,
          });
          recordThrottle('monthly_quota', err.used, err.limit);
          // A monthly quota does not clear on a timescale any retry can wait
          // out, so tell the client not to retry at all rather than letting the
          // Stainless default ("429 ⇒ retry") burn the caller's attempt budget
          // against a wall.
          throw new HTTPException(429, {
            res: jsonError(
              { error: 'quota_exceeded', key: err.key, limit: err.limit, used: err.used },
              429,
              NO_RETRY_HEADERS,
            ),
          });
        }
        throw err;
      }

      // Gates are done — start the retrieval clock (see `t0` above).
      t0 = performance.now();

      // GATE 5: GLOBAL (account-wide) AI throttle — right before the embedder +
      // reranker fan-out. The Workers AI quota is account-global, so this is the
      // only gate that sees aggregate load and protects tenants from each other
      // (the plan limit + concurrency cap are per-org/per-user). Fail-open.
      const globalAi = await stages.time('global_ai_throttle', {
        space_id: space.id,
      }, () => checkGlobalAiThrottle(c.env, {
        limit: limits.globalAiRpmCeiling,
        windowSeconds: GLOBAL_AI_WINDOW_SECONDS,
      }, defer));
      if (!globalAi.allowed) {
        logger.warn('retrieval.request_rejected', {
          stage: 'global_ai_throttle',
          space_id: space.id,
          status_code: 429,
          count: globalAi.count,
        });
        recordThrottle(
          'global_ai',
          globalAi.count,
          limits.globalAiRpmCeiling,
        );
        throw new HTTPException(429, {
          res: jsonError(
            {
              error: 'ai_capacity',
              detail:
                'Search is temporarily at capacity. Please retry shortly.',
            },
            429,
            { 'Retry-After': String(GLOBAL_AI_RETRY_AFTER_SECONDS) },
          ),
        });
      }

      const visibleUserIds = await stages.time('visibility_scope', {
        space_id: space.id,
      }, () => resolveReadVisibility(db, { orgId: space.orgId, userId }),
      (ids) => ({ outputCount: ids.length }));
      const scope: TenantScope = {
        orgId: space.orgId,
        spaceId: space.id,
        userId,
        visibleUserIds,
      };
      // No whole-space working-set load anymore — each signal narrows to a
      // bounded id set then hydrates by id (see candidates.ts). Owner display
      // names are resolved AFTER retrieve(), from the (≤topK) result candidates
      // only — the prior prefetch keyed off the full working set, which no
      // longer exists. One small indexed users-by-id query; not on any signal's
      // path (only the response uses owner names).

      const deps = {
        db,
        embedder,
        reranker: getReranker(c.env),
        vectorStore: getVectorStore(c.env, db),
      };
      const result = await withTimeout(
        retrieve({
          query: {
            text: body.query,
            topK: body.limit,
            candidatePool: CANDIDATE_POOL,
            recencyBias: body.recency_bias,
            rerank: body.rerank,
            graph: body.graph,
            diversify: body.diversify,
            // Lets retrieval skip the post-selection source-content read when
            // the response will not include it. Previously the full raw source
            // was loaded for every fused candidate regardless.
            includeSource: body.include_source,
          },
          scope,
          deps,
          entitlements,
          embedPromise,
          deferSourceContent: true,
          signal: deadline.signal,
          metrics,
          tracing,
          logger: logger.child({ space_id: space.id }),
        }),
        limits.retrievalTimeoutSeconds * 1000,
        deadline,
      );

      // Resolve owner display names for the result candidates only (≤topK). One
      // indexed users-by-id query; the result set is tiny, so this is off the
      // signal path and adds a single small round-trip to the response build.
      const ownerIdSet = [
        ...new Set(
          result.candidates
            .map((c) => c.ownerUserId)
            .filter((id): id is number => id != null),
        ),
      ];
      // Both reads depend only on the fixed top-K and are independent. Source
      // content remains fail-soft; owner names retain their prior fail-closed
      // behavior. When include_source=false no source query is started.
      const ownerRowsPromise = stages.time(
        'owner_name_load',
        {},
        () => ownerIdSet.length > 0
          ? db
              .select({ id: users.id, name: users.name })
              .from(users)
              .where(inArray(users.id, ownerIdSet))
          : Promise.resolve([]),
        (rows) => ({ inputCount: ownerIdSet.length, outputCount: rows.length }),
      );
      const sourceContentPromise = body.include_source && result.candidates.length > 0
        ? stages.time(
            'source_content_load',
            {},
            () => attachSourceContent(db, scope, result.candidates),
            () => ({
              inputCount: result.candidates.length,
              outputCount: result.candidates.length,
            }),
          ).catch(() => undefined)
        : Promise.resolve();
      const [ownerRows] = await Promise.all([ownerRowsPromise, sourceContentPromise]);
      const ownerById = new Map(
        ownerRows.map((owner) => [owner.id, owner.name]),
      );
      const response = await stages.time(
        'search_response_build',
        {},
        async () => buildResponse(
          ownerById,
          body.query,
          result,
          body.include_source,
        ),
        (built) => ({
          inputCount: result.candidates.length,
          outputCount: built.candidates.length,
        }),
      );
      const tookMs = durationMs(t0);
      logger.info('retrieval.request_completed', {
        space_id: space.id,
        duration_ms: tookMs,
        result_count: response.candidates.length,
        top_k: body.limit,
      });
      metrics.count('search', {
        tags: ['ok'],
        values: [tookMs, response.candidates.length],
        index: 'search',
      });

      // Write-side bookkeeping runs OFF the critical path via waitUntil — the
      // user never waits on it. `touch` bumps access_frequency (org+space
      // scoped, user_id=0); `recordSearchQueries` meters daily_usage. Both
      // non-fatal. The worker stays alive until these settle.
      const touchedIds = result.candidates.map((cm) => cm.memoryId);
      getBackgroundTasks(c).waitUntil(
        Promise.allSettled([
          touchMemories(db, { orgId: space.orgId, spaceId: space.id, userId: 0 }, touchedIds),
          recordSearchQueries(db, scope, 1),
        ]).then((results) => {
          for (const r of results) {
            if (r.status === 'rejected') {
              logger.warn('retrieval.write_side_effect_failed', {
                space_id: space.id,
              }, r.reason);
            }
          }
        }),
      );

      return await stages.time(
        'search_response_serialize',
        {},
        async () => c.json(response, 200),
        { inputCount: response.candidates.length },
      );
    } catch (err) {
      if (err instanceof TimeoutError) {
        logger.warn('retrieval.request_failed', {
          space_id: spaceId,
          duration_ms: durationMs(t0),
          status_code: 504,
          timed_out: true,
          error_category: 'internal',
          dependency: 'retrieval',
        });
        // Back the client off. A 504 here means retrieval was still running at
        // the deadline, which under load is exactly when an immediate retry
        // (the Stainless default for >=500) adds a second concurrent request
        // competing for the slot the first one just freed.
        throw new HTTPException(504, {
          res: jsonError(
            'Search timed out. Please try again.',
            504,
            retryAfterHeaders(RETRIEVAL_RETRY_AFTER_SECONDS),
          ),
        });
      }
      if (err instanceof HTTPException) throw err;

      // Provider-capacity and connection failures are dependency conditions, not
      // retrieval defects. Classified here rather than left to the global
      // handler because this route wraps everything in a 500 first — which is
      // exactly how 4,616 database-budget rejections were reported as
      // `api.unhandled_error` during the incident, hiding the real cause from
      // alerting and inviting the client to retry a dependency that had already
      // said it would not recover until a fixed time.
      const dependency = classifyDependencyError(err);
      if (dependency) {
        logger.error('retrieval.request_failed', {
          space_id: spaceId,
          duration_ms: durationMs(t0),
          status_code: dependency.status,
          code: dependency.code,
          error_category: 'external_service',
          dependency: dependency.dependency,
          deterministic: dependency.deterministic,
        }, err);
        metrics.count('search', { tags: ['error', dependency.code], index: 'search' });
        throw new HTTPException(dependency.status, {
          res: jsonError(
            { error: dependency.code, detail: dependency.detail, request_id: requestId },
            dependency.status,
            dependency.deterministic
              ? noRetryUntilHeaders(dependency.retryAfterSeconds)
              : retryAfterHeaders(dependency.retryAfterSeconds),
          ),
        });
      }

      logger.error('retrieval.request_failed', {
        space_id: spaceId,
        duration_ms: durationMs(t0),
        status_code: 500,
        ...failureFields(err),
      }, err);
      metrics.count('search', { tags: ['error'], index: 'search' });
      // Verbose error detail is opt-in via an EXPLICIT `DEBUG_ERRORS === 'true'`
      // flag — NOT merely "non-production". A staging/preview env that isn't
      // literally "production" must not leak internals by default. We NEVER
      // include a stack trace in the response (it can expose code paths / paths);
      // the full error (incl. stack) is already in the structured log above,
      // correlated by request_id. `request_id` is returned so a caller can quote
      // it for support without us leaking the message.
      const debugErrors =
        getApiConfig(c.env).debugErrors;
      const detail = debugErrors
        ? {
            error: 'retrieval_failed',
            message: err instanceof Error ? err.message : String(err),
            name: err instanceof Error ? err.name : typeof err,
            request_id: requestId,
          }
        : { error: 'retrieval_failed', request_id: requestId };
      // No automatic retry on an unexpected defect: a second identical request
      // is no likelier to succeed, and under load the retry is what turns a
      // fault into a cascade.
      throw new HTTPException(500, {
        res: jsonError(detail, 500, NO_RETRY_HEADERS),
      });
    } finally {
      // The concurrency slot MUST be released on every exit path. Schedule it
      // off the critical path: the release's KV write (~350ms cross-region)
      // must not block the response. `waitUntil` keeps the worker alive until
      // it settles; `release` itself never throws (it logs + swallows).
      //
      // Released BY TOKEN, so this frees the lease this request actually took
      // and nobody else's. If the isolate is terminated before this runs, the
      // lease's TTL reclaims it instead.
      defer(concurrency.release(userKey, lease.token));

      // Abort on EVERY exit path, including success and error. A fail-soft
      // auxiliary signal can still be in flight when the essential ones have
      // already produced a result, and an error path can leave calls running
      // that nothing will ever read. Aborting here stops that work from
      // outliving the response it was for. Aborting an already-settled
      // controller is a no-op, and `release` above never throws.
      deadline.abort(new TimeoutError());
    }
    });
  },
);
