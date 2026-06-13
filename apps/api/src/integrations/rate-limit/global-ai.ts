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
 * **Design.** A KV fixed-window counter under one shared key (no org/user in the
 * key — it's intentionally global). Mirrors the IP limiter's structure. Sized
 * generously (`GLOBAL_AI_RPM_CEILING`) so it only trips on genuine aggregate
 * overload, not normal peak.
 *
 * **Fail-OPEN.** Any KV error (or no KV binding) ALLOWS the request and logs.
 * A KV hiccup must never block all search across the platform. Read-then-write
 * is non-atomic, so the count is approximate (±a few on the boundary) — fine for
 * a coarse safety ceiling.
 */

const GLOBAL_AI_KEY_PREFIX = 'rl:global-ai:';

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
): Promise<GlobalAiThrottleResult> {
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
    await kv.put(key, String(next), {
      expirationTtl: Math.max(60, opts.windowSeconds * 2),
    });
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
