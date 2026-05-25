import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import type { HonoEnv } from '../../bindings';
import { getDb } from '../../db';
import {
  enforcePlanRateLimit,
  getRateLimiter,
  RateLimitError,
} from '../../integrations/rate-limit';
import { getEmbedder } from '../../integrations/embeddings';
import { getReranker } from '../../integrations/reranker';
import type { TenantScope } from '../../lib/scope';
import { requireAuth } from '../auth/middleware';
import { requirePrincipal } from '../auth/principal';
import { checkQuota, getEntitlements, QuotaExceededError } from '../orgs/entitlements';
import { getSpaceByUuid } from '../spaces/service';
import { recordSearchQueries } from '../usage/service';
import { loadRetrievalCandidates, touchMemories } from './candidates';
import { getConcurrencyLimiter } from './concurrency';
import {
  CANDIDATE_POOL,
  RETRIEVAL_MAX_CONCURRENT_PER_USER,
  RETRIEVAL_RESULT_TIMEOUT_SECONDS,
  RETRIEVAL_USER_COUNTER_TTL_SECONDS,
} from './constants';
import { SearchRequestSchema, SearchResponseSchema } from './schemas';
import { retrieve } from './service';
import type { CandidateMemory, RetrievalResult } from './types';

export const searchRoutes = new OpenAPIHono<HonoEnv>();

const ErrorBody = z.object({ detail: z.unknown() }).openapi('SearchErrorBody');

class TimeoutError extends Error {}

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
}

function buildResponse(
  uuidById: Map<number, string>,
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

    // Fetch org entitlements ONCE per request, then share with the rate-limit
    // gate, the quota gate, and the orchestrator (was 3 separate fetches).
    // The space-access check below guarantees space.orgId === orgId, so the
    // same entitlements apply throughout.
    const entitlements = await getEntitlements(db, orgId);

    // 2. Per-org plan rate limit.
    const limiter = getRateLimiter(c.env);
    try {
      await enforcePlanRateLimit(db, limiter, orgId, entitlements);
    } catch (err) {
      if (err instanceof RateLimitError) {
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
    // or cross-tenant (no existence leak).
    const space = await getSpaceByUuid(db, body.space_id);
    if (!space || space.orgId !== orgId) {
      throw new HTTPException(404, {
        res: jsonError(`Space ${body.space_id} not found`, 404),
      });
    }

    // 4. Monthly search-query quota (optimistic +1, enforce-only).
    try {
      await checkQuota(db, space.orgId, 'monthly_search_queries', 1, entitlements);
    } catch (err) {
      if (err instanceof QuotaExceededError) {
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
    const concurrency = getConcurrencyLimiter(c.env);
    const userKey = String(userId);
    const acquired = await concurrency.acquire(
      userKey,
      RETRIEVAL_MAX_CONCURRENT_PER_USER,
      RETRIEVAL_USER_COUNTER_TTL_SECONDS,
    );
    if (!acquired) {
      throw new HTTPException(429, {
        res: jsonError(
          'Too many concurrent searches. Wait for existing searches to complete.',
          429,
        ),
      });
    }

    const t0 = performance.now();
    try {
      const scope: TenantScope = { orgId: space.orgId, spaceId: space.id, userId };
      const candidates = await loadRetrievalCandidates(db, scope);
      const deps = {
        db,
        embedder: getEmbedder(c.env),
        reranker: getReranker(c.env),
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
        }),
        RETRIEVAL_RESULT_TIMEOUT_SECONDS * 1000,
      );

      // Map int id → uuid from the already-loaded scoped memories (no extra
      // query). Result candidates are a subset of candidates.memories.
      const uuidById = new Map(candidates.memories.map((m) => [m.id, m.uuid]));
      const response = buildResponse(
        uuidById,
        body.query,
        result,
        performance.now() - t0,
        body.include_source,
      );

      // Write-side bookkeeping runs OFF the critical path via waitUntil — the
      // user never waits on it. `touch` bumps access_frequency (org+space
      // scoped, user_id=0); `recordSearchQueries` meters daily_usage. Both
      // non-fatal. The worker stays alive until these settle.
      const touchedIds = result.candidates.map((cm) => cm.memoryId);
      c.executionCtx.waitUntil(
        Promise.allSettled([
          touchMemories(db, { orgId: space.orgId, spaceId: space.id, userId: 0 }, touchedIds),
          recordSearchQueries(db, scope, 1),
        ]).then((results) => {
          for (const r of results) {
            if (r.status === 'rejected') {
              console.warn('search_write_side_effect_failed', { error: String(r.reason) });
            }
          }
        }),
      );

      return c.json(response, 200);
    } catch (err) {
      if (err instanceof TimeoutError) {
        throw new HTTPException(504, {
          res: jsonError('Search timed out. Please try again.', 504),
        });
      }
      if (err instanceof HTTPException) throw err;
      console.error('retrieval_failed', err);
      // Outside production, surface the real error in the response body so it
      // can be debugged without a logging pipeline. Production keeps the
      // generic message — no stack/internal leak. Flip the `ENVIRONMENT` var
      // away from "production" (e.g. in the dashboard) to enable this on a
      // deployed worker, then flip it back.
      const detail =
        c.env.ENVIRONMENT === 'production'
          ? 'Search failed unexpectedly.'
          : {
              error: 'retrieval_failed',
              message: err instanceof Error ? err.message : String(err),
              name: err instanceof Error ? err.name : typeof err,
              stack: err instanceof Error ? err.stack : undefined,
            };
      throw new HTTPException(500, { res: jsonError(detail, 500) });
    } finally {
      // The concurrency slot MUST be released on every exit path.
      await concurrency.release(userKey);
    }
  },
);
