import { createLogger } from '@crosmos/observability';
import type { Env } from '../../bindings';

/**
 * GLOBAL (account-wide) throttle in front of the shared Cloudflare Workers AI
 * quota (embeddings + reranker).
 *
 * The Workers AI quota is account-global: it is NOT partitioned per org. So one
 * org bursting search traffic can exhaust it and surface as 429/503 for every
 * other tenant (noisy neighbour — see memory: "retrieval ceiling = Workers AI").
 * The per-org plan rate limit and per-user concurrency cap can't see this
 * aggregate, so this gate adds a single account-wide ceiling in front of the AI
 * fan-out.
 *
 * **Design.** A single fixed-window counter under one shared key (no org/user
 * in the key — it's intentionally global). Sized generously
 * (`GLOBAL_AI_RPM_CEILING`) so it only trips on genuine aggregate overload, not
 * normal peak.
 *
 * **Backend.** Prefers the strongly-consistent `RateLimiterDO` (`RATE_LIMITER`
 * binding): its counter is in-memory in the DO, so it costs **zero KV puts** —
 * the reason we migrated off the KV path, which wrote a counter on every search
 * against the free tier's 1000/day put cap. Falls back to a KV fixed-window
 * counter when the DO binding is absent (older envs / no binding), and to
 * allow-all when neither is bound (dev/tests).
 *
 * **Fail-OPEN.** Any backend error (or no binding) ALLOWS the request and logs.
 * A limiter hiccup must never block all search across the platform.
 *
 * **Latency.** The DO path is a single atomic check-and-increment round-trip
 * (intra-region, single-digit ms). The KV fallback reads synchronously (edge-
 * cached) and pushes the write off the critical path via the optional `defer`
 * (the request's `waitUntil`) — a KV write is ~350ms cross-region.
 */

const GLOBAL_AI_KEY_PREFIX = 'rl:global-ai:';
/** Single DO instance key for the global counter (window handled in the DO). */
const GLOBAL_AI_DO_KEY = 'rl:global-ai';

/** Schedules a fire-and-forget task (typically `executionCtx.waitUntil`). */
export type DeferFn = (task: Promise<unknown>) => void;

export interface GlobalAiThrottleOptions {
  /** Max AI fan-outs allowed account-wide per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

export interface GlobalAiThrottleResult {
  /** `true` if the request is under the ceiling and may proceed. */
  allowed: boolean;
  /** Observed count in the current window (for logging/metrics). */
  count: number;
}

/**
 * Check + increment the global AI counter for the current fixed window. Returns
 * `{ allowed }`. Never throws — on any failure it returns `allowed: true`
 * (fail-open). When there is no KV binding (dev/tests) it also allows.
 */
export async function checkGlobalAiThrottle(
  env: Env,
  opts: GlobalAiThrottleOptions,
  defer?: DeferFn,
): Promise<GlobalAiThrottleResult> {
  // Prefer the DO — strongly consistent and, unlike KV, costs no put ops.
  if (env.RATE_LIMITER) {
    return checkViaDo(env, opts);
  }

  const kv = env.API_KEY_CACHE;
  if (!kv) return { allowed: true, count: 0 };

  try {
    const now = Math.floor(Date.now() / 1000);
    const windowBucket = Math.floor(now / opts.windowSeconds);
    const key = `${GLOBAL_AI_KEY_PREFIX}${windowBucket}`;
    const raw = await kv.get(key);
    const current = raw ? Number(raw) : 0;
    const next = current + 1;
    // Keep the key alive a little past the window so late requests still count.
    // Defer the write off the critical path when a scheduler is supplied; only
    // await it (to avoid losing the increment to teardown) when one isn't.
    const write = kv
      .put(key, String(next), { expirationTtl: Math.max(60, opts.windowSeconds * 2) })
      .catch((err) =>
        createLogger({ service: 'api', environment: env.ENVIRONMENT }).warn(
          'ratelimit.global_ai_kv_failure',
          { stage: 'global_ai_write', scope: 'global' },
          err,
        ),
      );
    if (defer) defer(write);
    else await write;
    return { allowed: next <= opts.limit, count: next };
  } catch (err) {
    // Fail open: a KV hiccup must not block all search.
    createLogger({ service: 'api', environment: env.ENVIRONMENT }).warn(
      'ratelimit.global_ai_kv_failure',
      { stage: 'global_ai_throttle', scope: 'global' },
      err,
    );
    return { allowed: true, count: 0 };
  }
}

/**
 * DO-backed variant: one `RateLimiterDO` instance holds the global counter and
 * manages the fixed window internally (so no window bucket in the key). The
 * check-and-increment is a single atomic round-trip; `defer` is unused because
 * there's no separate write to push off the critical path. Fail-open on any
 * error, matching the KV path.
 */
async function checkViaDo(
  env: Env,
  opts: GlobalAiThrottleOptions,
): Promise<GlobalAiThrottleResult> {
  try {
    const id = env.RATE_LIMITER!.idFromName(GLOBAL_AI_DO_KEY);
    // `enam` pins the DO near the prod workers' region (aws:us-east-1).
    const stub = env.RATE_LIMITER!.get(id, { locationHint: 'enam' });
    const res = await stub.fetch('https://ratelimit/limit', {
      method: 'POST',
      body: JSON.stringify({ limit: opts.limit, windowSeconds: opts.windowSeconds }),
    });
    const { success, count } = (await res.json()) as {
      success: boolean;
      count: number;
    };
    return { allowed: success, count };
  } catch (err) {
    // Fail open: a DO hiccup must not block all search.
    createLogger({ service: 'api', environment: env.ENVIRONMENT }).warn(
      'ratelimit.global_ai_do_failure',
      { stage: 'global_ai_throttle', scope: 'global' },
      err,
    );
    return { allowed: true, count: 0 };
  }
}
