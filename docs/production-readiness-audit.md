# Production Readiness Audit & Remediation

_Audit run 2026-06-13 via a 25-agent fan-out (10 dimension finders → adversarial verification → synthesis). 43 raw findings → 13 confirmed high/critical + ~29 medium/low. The scariest candidates (cross-tenant exfil, auth bypass, webhook double-spend) were **refuted** on verification — the system is well-built; these are gaps in an already-hardened design._

## Posture
Already solid: consistent multi-tenant `scope*` filtering, fail-open KV rate limiting (honest about ±1–2 fuzz), idempotent + prod-validated ingestion, structured logging with a field allowlist, CF Logs/Traces enabled, HMAC webhook verification with per-event idempotency. The remaining gaps cluster in: stale-cache privilege revocation, vector/data lifecycle leaks under the default Vectorize backend, and the absence of a metrics/alerting layer.

## P0 — must fix before scale
1. **Privilege-revocation bypass.** `orgs/routes.ts` DELETE-member (`:494`) / PATCH-role (`:433`) never call `invalidateMembership` → removed/demoted members keep access (and role) up to 60s (KV TTL). → call `invalidateMembership` after both mutations.
2. **Silent entity-vector corruption.** `ingestion/extractors/resolve-entity.ts:223` commits the entity row before the Vectorize upsert; a post-commit 429/503 is never re-upserted on retry (purge preserves entities) → entity permanently un-indexed. → upsert the vector for every resolved entity in the run (idempotent), not only when `isNew`.

## P1 — should fix soon
- **Security:** admin can demote/remove an owner (no rank check); refresh-token rotation race + no reuse detection.
- **Silent failures:** invite email via raw `waitUntil` (no logging); cancelled jobs drop token-usage accounting and leave sources stuck `pending`.
- **Data lifecycle:** source/space delete leaks Vectorize vectors; no retention cron for `authorization_codes`/`revoked_refresh_tokens`/`ingestion_jobs`/`daily_usage`/`billing_events`.
- **Concurrency:** `max_memory_spaces` and `MAX_PENDING_JOBS_PER_USER` are non-atomic count-then-act.
- **Billing:** out-of-order Polar webhook can resurrect a revoked subscription.
- **Scale/pagination:** graph + entities + org-members lists paginate in-memory; no request-body size cap.
- **Rate-limit/abuse:** unauthenticated auth/OAuth endpoints have no limiter (need per-IP); invite email mail-bomb; `/oauth/register` flood; deferred-write KV limiter bypassable on the AI-cost path; no global Workers-AI throttle (noisy-neighbor).
- **Error clarity:** JWT lib messages leak into 401s; inconsistent `detail` shape; `request_id` missing from 4xx; domain errors surface as 500s.

## P2 — hardening
Job-store/candidates/entity-detail scope defense-in-depth; unbounded string inputs; OAuth/jose error passthrough; search non-prod stack leak; billing limiter fail-open log; stuck-RPC-job sweeper; correlation_id ↔ request_id stitch; OAuth error-key convention.

## Observability plan (CF Analytics Engine + alerts)
- Add an `ANALYTICS` Analytics Engine binding to both workers + a `metric()` helper alongside the logger.
- Emit: ingestion outcome (status/error_category/duration/tokens), search (status/stage/duration/result_count), rate-limit/quota 429s, auth failures (reason/auth_method), LLM/embedder errors (provider/model/status/retryable).
- Add a global access-log middleware (`http.request`) + structured auth-failure logs; fix `FIELD_ALLOWLIST` drift.
- Alert on: ingestion failure rate >5%/10m, search p95 >3s, embedder/search 429+503 spikes (Workers-AI ceiling early warning), per-IP/per-org 401 spikes, `rate_limit.kv_failure` >0, any DLQ delivery, billing re-activation-after-revoke.

## Refuted (checked, not real)
Polar webhook double-dispatch (every effect idempotent); OAuth callback DB-DoS / welcome-email spam (gated behind a real Google-signed id_token); OAuth error-leak as high (only standardized OAuth/jose text, no secrets/PII).

---

## Remediation status (shipped 2026-06-13, deployed to prod)
Commits `b3e8dba` (foundations) → `dd27af9` (P0/P1/P2) → `b55d221` (DO limiter + canonical validation). Both workers deployed to production and verified live.

**Done & verified in prod:**
- Both P0s (membership invalidation; entity-vector re-upsert). Ingestion e2e re-tested: 3 entities / 1 memory / 2 edges, searchable; source delete removes the memory.
- Per-IP limiter on all unauthenticated auth/OAuth routes — **Durable Object** backed (see below), verified precise (30/30→429 standard, 5/5→429 strict).
- Canonical error envelope (`detail` always string + `code` + `request_id` + `fields`) across onError / 404 / validation (via shared `createApiApp()` factory) / HTTPException. JWT-oracle messages collapsed. Verified live.
- 10MB body cap (413). Atomic space-quota + pending-jobs cap. Refresh-token atomic rotation + reuse detection. Owner-rank guard. Source/space delete vector purge. Daily retention cron. Billing monotonic guard. Pagination + COUNT (entities/graph/members). Defense-in-depth scoping (jobs/candidates/entity-detail). Generic OAuth errors. String-input caps.
- Structured `auth.failed` logs, global `http.request` access log, metric emission sites — all wired.

**Rate-limiter primitive — important finding.** KV is eventually consistent (read-after-write lag) so a KV counter **cannot bound a burst** — verified live (36 rapid requests, 0 limited). The experimental `[[unsafe.bindings]] type="ratelimit"` binding also did **not** enforce its `simple` limit under a named environment (returned `{success:true}` for all 37 requests). The working primitive is a **SQLite-backed Durable Object** (`RateLimiterDO`, one instance per `${bucket}:${ip}` key) — strongly consistent, enforces precisely. Note: the per-org KV plan limiter and the global-AI KV throttle share KV's burst weakness (coarse by design / accepted ±fuzz); migrate them to the DO pattern if precise per-org enforcement is ever needed.

## Follow-ups (require account/dashboard action — not code)
1. **Enable Analytics Engine** on the Cloudflare account (dashboard → Workers → Analytics Engine), then uncomment the 4 `analytics_engine_datasets` blocks in the two `wrangler.toml` files and redeploy. Until then, metrics `count()` calls no-op gracefully — **all signals are still captured as structured logs** (CF Workers Logs), so observability is functional; this only lights up the queryable counters.
2. **Configure alerts** (per the Monitoring plan above) once metrics flow — or build them on the structured logs now (CF Logs → Logpush/alerts).
3. The test org's (`divyansh`, id 1) monthly `daily_usage.tokens_ingested` was reset to 0 to run the ingestion e2e test — it was synthetic test data; left reset.
