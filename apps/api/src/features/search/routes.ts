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
import { loadRetrievalCandidates, touchMemories } from './candidates';
import { getConcurrencyLimiter } from './concurrency';
import {
  CANDIDATE_POOL,
  GLOBAL_AI_RETRY_AFTER_SECONDS,
  GLOBAL_AI_RPM_CEILING,
  GLOBAL_AI_WINDOW_SECONDS,
  RETRIEVAL_MAX_CONCURRENT_PER_USER,
  RETRIEVAL_RESULT_TIMEOUT_SECONDS,
  RETRIEVAL_USER_COUNTER_TTL_SECONDS,
} from './constants';
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
  recorded_at: string;
  event_time: string | null;
  owner_id: string | null;
  owner_name: string | null;
}

function buildResponse(
  uuidById: Map<number, string>,
  ownerById: Map<number, { uuid: string; name: string }>,
  queryText: string,
  result: RetrievalResult,
  tookMs: number,
  includeSource: boolean,
): {
  query: string;
  candidates: SearchCandidateOut[];
  total: number;
  took_ms: number;
} {
  const raw = result.candidates;
  if (raw.length === 0) {
    return { query: queryText, candidates: [], total: 0, took_ms: tookMs };
  }

  // No DB query: every result candidate came from the already-loaded scoped
  // memory set, so its uuid is in `uuidById` (built from candidates.memories).
  const uuidMap = uuidById;

  const candidates: SearchCandidateOut[] = raw.map((c: CandidateMemory) => {
    const out: SearchCandidateOut = {
      // Fall back to the raw int (as Python does) if a uuid is somehow missing.
      memory_id: uuidMap.get(c.memoryId) ?? String(c.memoryId),
      content: c.content,
      memory_type: c.memoryType,
      score: c.finalScore,
      created_at: c.createdAt.toISOString(),
      recorded_at: c.recordedAt.toISOString(),
      event_time: c.eventTime ? c.eventTime.toISOString() : null,
      owner_id: c.ownerUserId != null ? ownerById.get(c.ownerUserId)?.uuid ?? null : null,
      owner_name: c.ownerUserId != null ? ownerById.get(c.ownerUserId)?.name ?? null : null,
    };
    // include_source=true → key present (value may be null); false → omit key.
    if (includeSource) out.source = c.sourceChunk ?? null;
    return out;
  });

  return { query: queryText, candidates, total: candidates.length, took_ms: tookMs };
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

    // Fetch org entitlements ONCE per request (KV-cached), then share with the
    // rate-limit gate, the quota gate, and the orchestrator (was 3 separate
    // fetches). The space-access check below guarantees space.orgId === orgId,
    // so the same entitlements apply throughout.
    const entitlements = await logger.time('retrieval.stage_completed', {
      stage: 'entitlements',
    }, () => getCachedEntitlements(c, orgId));

    // KV writes commit cross-region (~350ms from this Smart-Placed worker), so
    // the rate-limit + concurrency counters push their writes here instead of
    // blocking the response. The worker stays alive until they settle.
    const defer = (task: Promise<unknown>) => getBackgroundTasks(c).waitUntil(task);

    // 2. Per-org plan rate limit.
    //
    // FIX (deferred-write bypass): search is on the expensive AI-cost path, and
    // deferring the counter write (for latency) lets M simultaneous searches all
    // read the same pre-increment count and admit — bypassing the per-org cap.
    // Here we DON'T pass `defer`, so the limiter AWAITS the increment before
    // deciding, making the per-org cap accurate on this path. The added cost is
    // ~one KV write (~350ms) — acceptable because (a) the per-org AI spend is
    // what we're protecting and (b) the global-AI throttle below already caps
    // aggregate load. Concurrency + global throttle still defer / are coarse.
    const limiter = getRateLimiter(c.env);
    try {
      await logger.time('retrieval.stage_completed', {
        stage: 'plan_rate_limit',
      }, () => enforcePlanRateLimit(db, limiter, orgId, entitlements));
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

    // 3. Space access — authoritative org is the SPACE's org. 404 on missing
    // or cross-tenant (no existence leak). KV-cached (slim {id, orgId}).
    const space = await logger.time('retrieval.stage_completed', {
      stage: 'space_access',
    }, () => getCachedSpaceByUuid(c, body.space_id));
    if (!space || space.orgId !== orgId) {
      logger.warn('retrieval.request_rejected', {
        stage: 'space_access',
        status_code: 404,
      });
      throw new HTTPException(404, {
        res: jsonError(`Space ${body.space_id} not found`, 404),
      });
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
          RETRIEVAL_MAX_CONCURRENT_PER_USER,
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
        limit: GLOBAL_AI_RPM_CEILING,
        windowSeconds: GLOBAL_AI_WINDOW_SECONDS,
      }));
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
      const candidateLoadStart = performance.now();
      const candidates = await loadRetrievalCandidates(db, scope);
      logger.info('retrieval.stage_completed', {
        stage: 'candidate_load',
        space_id: space.id,
        duration_ms: durationMs(candidateLoadStart),
        memory_count: candidates.memories.length,
        entity_count: candidates.entities.length,
      });
      const deps = {
        db,
        embedder: getEmbedder(c.env),
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
          candidates,
          deps,
          entitlements,
          logger: logger.child({ space_id: space.id }),
        }),
        RETRIEVAL_RESULT_TIMEOUT_SECONDS * 1000,
      );

      // Map int id → uuid from the already-loaded scoped memories (no extra
      // query). Result candidates are a subset of candidates.memories.
      const uuidById = new Map(candidates.memories.map((m) => [m.id, m.uuid]));
      const ownerIds = [
        ...new Set(
          result.candidates
            .map((candidate) => candidate.ownerUserId)
            .filter((id): id is number => id != null),
        ),
      ];
      const ownerRows =
        ownerIds.length > 0
          ? await db
              .select({ id: users.id, uuid: users.uuid, name: users.name })
              .from(users)
              .where(inArray(users.id, ownerIds))
          : [];
      const ownerById = new Map(
        ownerRows.map((owner) => [
          owner.id,
          { uuid: owner.uuid, name: owner.name },
        ]),
      );
      const response = buildResponse(
        uuidById,
        ownerById,
        body.query,
        result,
        performance.now() - t0,
        body.include_source,
      );
      logger.info('retrieval.request_completed', {
        space_id: space.id,
        duration_ms: durationMs(t0),
        candidate_count: candidates.memories.length,
        result_count: response.total,
        top_k: body.limit,
      });
      metrics.count('search', {
        tags: ['ok'],
        values: [durationMs(t0), response.total],
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
