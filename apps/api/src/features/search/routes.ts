import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { createApiApp } from '../../lib/openapi';
import { users } from '@crosmos/db';
import { EmbeddingRequestError, RerankerRequestError } from '@crosmos/ai';
import { createLogger, createMetrics, durationMs } from '@crosmos/observability';
import { inArray } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import type { HonoEnv } from '../../bindings';
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
import { checkQuota, QuotaExceededError } from '../orgs/entitlements';
import { getCachedEntitlements, getCachedSpaceByUuid } from '../../lib/gate-cache';
import { getBackgroundTasks } from '../../lib/runtime';
import { recordSearchQueries } from '../usage/service';
import { resolveReadVisibility } from '../visibility/service';
import { touchMemories } from './candidates';
import { getConcurrencyLimiter } from './concurrency';
import {
  CANDIDATE_POOL,
  GLOBAL_AI_RETRY_AFTER_SECONDS,
  GLOBAL_AI_WINDOW_SECONDS,
  RETRIEVAL_RESULT_TIMEOUT_SECONDS,
  RETRIEVAL_USER_COUNTER_TTL_SECONDS,
} from './constants';
import { getOperationalLimits } from '../../lib/limits';
import { SearchRequestSchema, SearchResponseSchema } from './schemas';
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

/** Reject after `ms`; the underlying work is not cancellable on Workers. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError()), ms);
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
    });

    // KV writes commit cross-region (~350ms from this Smart-Placed worker), so
    // the rate-limit + concurrency counters push their writes here instead of
    // blocking the response. The worker stays alive until they settle.
    const defer = (task: Promise<unknown>) => getBackgroundTasks(c).waitUntil(task);

    // Entitlements + space access are independent, side-effect-free KV reads, so
    // fetch them CONCURRENTLY. On a cold isolate each KV read is ~150-200ms;
    // serialized they dominated gate latency. Entitlements is shared with the
    // rate-limit gate, the quota gate, and the orchestrator (was 3 fetches); the
    // space check guarantees space.orgId === orgId so the entitlements apply
    // throughout. The remaining gates (rate-limit → quota → concurrency) stay
    // ordered because they have side effects (counter increments, slot acquire)
    // whose sequencing is semantically meaningful.
    const [entitlements, space] = await Promise.all([
      logger.time('retrieval.stage_completed', { stage: 'entitlements' },
        () => getCachedEntitlements(c, orgId)),
      logger.time('retrieval.stage_completed', { stage: 'space_access' },
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
    if (!c.var.planRateLimitEnforced) {
      const limiter = getRateLimiter(c.env, defer);
      try {
        await logger.time('retrieval.stage_completed', {
          stage: 'plan_rate_limit',
        }, () => enforcePlanRateLimit(db, limiter, orgId, entitlements));
        c.set('planRateLimitEnforced', true);
      } catch (err) {
        if (err instanceof RateLimitError) {
          logger.warn('retrieval.request_rejected', {
            stage: 'plan_rate_limit',
            status_code: 429,
          });
          metrics.count('search_throttled', { tags: ['plan_rate_limit'] });
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
    }

    // 4. Monthly search-query quota (optimistic +1, enforce-only).
    try {
      await logger.time('retrieval.stage_completed', {
        stage: 'monthly_quota',
        space_id: space.id,
      }, () => checkQuota(db, space.orgId, 'monthly_search_queries', 1, entitlements));
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        logger.warn('retrieval.request_rejected', {
          stage: 'monthly_quota',
          status_code: 429,
        });
        metrics.count('search_throttled', { tags: ['monthly_quota'] });
        throw new HTTPException(429, {
          res: jsonError(
            { error: 'quota_exceeded', key: err.key, limit: err.limit, used: err.used },
            429,
          ),
        });
      }
      throw err;
    }

    // 6. Per-user concurrency cap. (5. queue-depth gate dropped inline — §4.)
    const concurrency = getConcurrencyLimiter(c.env, defer);
    const userKey = String(userId);
    const acquired = await logger.time(
      'retrieval.stage_completed',
      {
        stage: 'concurrency_acquire',
        space_id: space.id,
      },
      () =>
        concurrency.acquire(
          userKey,
          limits.retrievalMaxConcurrentPerUser,
          RETRIEVAL_USER_COUNTER_TTL_SECONDS,
        ),
    );
    if (!acquired) {
      logger.warn('retrieval.request_rejected', {
        stage: 'concurrency_acquire',
        space_id: space.id,
        status_code: 429,
      });
      metrics.count('search_throttled', { tags: ['concurrency'] });
      throw new HTTPException(429, {
        res: jsonError(
          'Too many concurrent searches. Wait for existing searches to complete.',
          429,
        ),
      });
    }

    const t0 = performance.now();
    try {
      // 7. GLOBAL (account-wide) AI throttle — right before the embedder +
      // reranker fan-out. The Workers AI quota is account-global, so this is the
      // only gate that sees aggregate load and protects tenants from each other
      // (the plan limit + concurrency cap are per-org/per-user). Fail-open. Run
      // inside the try so the `finally` still releases the concurrency slot.
      const globalAi = await logger.time('retrieval.stage_completed', {
        stage: 'global_ai_throttle',
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
        metrics.count('search_throttled', { tags: ['global_ai'] });
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

      // EARLY EMBED — kick the query embedding off NOW so the external call
      // (~370ms, OpenAI) overlaps the visibility + working-set DB round-trips
      // below instead of running after them inside retrieve(). The signals then
      // find the vector already resolved. Quality-neutral (same vector).
      const embedder = getEmbedder(c.env);
      const embedPromise = embedder.embed(body.query, { mode: 'search' });
      // retrieve() awaits this; guard the pre-await window so a rejection here
      // isn't reported as an unhandled rejection.
      embedPromise.catch(() => {});

      const visibleUserIds = await logger.time('retrieval.stage_completed', {
        stage: 'visibility_scope',
        space_id: space.id,
      }, () => resolveReadVisibility(db, { orgId: space.orgId, userId }));
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
          },
          scope,
          deps,
          entitlements,
          embedPromise,
          logger: logger.child({ space_id: space.id }),
        }),
        RETRIEVAL_RESULT_TIMEOUT_SECONDS * 1000,
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
      const ownerRows =
        ownerIdSet.length > 0
          ? await db
              .select({ id: users.id, name: users.name })
              .from(users)
              .where(inArray(users.id, ownerIdSet))
          : [];
      const ownerById = new Map(
        ownerRows.map((owner) => [owner.id, owner.name]),
      );
      const response = buildResponse(
        ownerById,
        body.query,
        result,
        body.include_source,
      );
      logger.info('retrieval.request_completed', {
        space_id: space.id,
        duration_ms: durationMs(t0),
        result_count: response.candidates.length,
        top_k: body.limit,
      });
      metrics.count('search', {
        tags: ['ok'],
        values: [durationMs(t0), response.candidates.length],
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

      return c.json(response, 200);
    } catch (err) {
      if (err instanceof TimeoutError) {
        logger.warn('retrieval.request_failed', {
          space_id: space.id,
          duration_ms: durationMs(t0),
          status_code: 504,
          timed_out: true,
          error_category: 'internal',
          dependency: 'retrieval',
        });
        throw new HTTPException(504, {
          res: jsonError('Search timed out. Please try again.', 504),
        });
      }
      if (err instanceof HTTPException) throw err;
      logger.error('retrieval.request_failed', {
        space_id: space.id,
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
        (c.env as { DEBUG_ERRORS?: string }).DEBUG_ERRORS === 'true';
      const detail = debugErrors
        ? {
            error: 'retrieval_failed',
            message: err instanceof Error ? err.message : String(err),
            name: err instanceof Error ? err.name : typeof err,
            request_id: requestId,
          }
        : { error: 'retrieval_failed', request_id: requestId };
      throw new HTTPException(500, { res: jsonError(detail, 500) });
    } finally {
      // The concurrency slot MUST be released on every exit path. Schedule it
      // off the critical path: the release's KV write (~350ms cross-region)
      // must not block the response. `waitUntil` keeps the worker alive until
      // it settles; `release` itself never throws (it logs + swallows).
      defer(concurrency.release(userKey));
    }
  },
);
