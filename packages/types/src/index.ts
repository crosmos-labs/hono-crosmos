// Reserved for cross-worker contracts shared by both `apps/api` and
// `apps/ingestion`. The most important consumer will be Cloudflare Queues
// message shapes — both the producer (api) and consumer (ingestion) need to
// agree on the wire format.
//
// Per-feature Zod request/response schemas live next to their feature in
// apps/api/src/features/<domain>/schemas.ts, not here.

export {};
