// Reserved for cross-worker contracts shared by both `apps/api` and
// `apps/ingestion`. The most important consumer will be Cloudflare Queues
// message shapes — both the producer (api) and consumer (ingestion) need to
// agree on the wire format.
//
// Per-feature Zod request/response schemas live next to their feature in
// apps/api/src/features/<domain>/schemas.ts, not here.

/**
 * `TenantScope` is built once at the API boundary after auth+authz has
 * verified the principal has access to the space, then threaded down through
 * services, the queue payload, and the worker pipeline. Every read/write
 * touching org-scoped tables must filter by **both** `orgId` and `spaceId`.
 *
 * `userId` is in the scope for usage attribution only (`daily_usage.user_id`)
 * — by the time a scope exists, authorization has already passed.
 *
 * See .codex/stack-and-practices.md.
 */
export interface TenantScope {
  readonly orgId: number;
  readonly spaceId: number;
  readonly userId: number;
}

/**
 * Wire-format contract between the API worker (producer) and the ingestion
 * worker (consumer). Both must agree on this shape — change it in both apps
 * in the same deploy.
 *
 * Ints, not UUIDs: the producer already resolved every UUID when verifying
 * space access; the consumer pipeline issues integer FK joins everywhere.
 */
export interface IngestionJobMessage {
  task: 'process_ingestion';
  job_id: string;
  correlation_id: string;
  org_id: number;
  space_id: number;
  user_id: number;
  source_ids: number[];
  /** Producer wall-clock timestamp in milliseconds, used for queue-delay logs. */
  enqueued_at_ms?: number;
}

export type IngestionJobStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled';

/**
 * Result blob written onto `ingestion_jobs.result` at the terminal
 * transition. See .codex/pipelines.md.
 */
export interface IngestionJobResult {
  source_ids: number[];
  failed_source_ids: number[];
  memory_count: number;
  entity_count: number;
  edge_count: number;
  tokens_used: number;
  source_errors?: Record<string, string>;
  error_message?: string;
}
