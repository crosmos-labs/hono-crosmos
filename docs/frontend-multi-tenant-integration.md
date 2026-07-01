# Frontend KT — Multi-tenant integration (space-scoped keys + per-space usage)

Audience: frontend / app engineers integrating Crosmos into a product that serves
their **own end-users** (B2B2C). This documents two new, fully backward-compatible
additions:

1. **Space-scoped API keys** — an API key that can only touch one memory space,
   safe to hand to a single end-user's client.
2. **Per-space usage rollup** — read tokens + queries for one space, so you can
   attribute/bill usage down to a single end-user.

Nothing here changes existing behavior. Org-wide keys and JWT auth are untouched;
every new field is optional and every existing request works unchanged.

---

## Mental model

Crosmos tenancy is: **Organization → Memory Space → memories**. For a B2B2C app,
the clean mapping is **one memory space per end-user**:

```
your org (one Crosmos account)
├── space "enduser_<yourUserId_A>"   ← end-user A's isolated memory
├── space "enduser_<yourUserId_B>"   ← end-user B's isolated memory
└── ...
```

Spaces are hard-isolated. A space name is unique per org, so you can name spaces
after your own user IDs and keep the mapping in your DB.

Two ways to drive it:

- **Server-side (recommended default):** your backend holds ONE org-wide key,
  creates a space per end-user, and passes that space's `id` on every
  ingest/search. Simplest, most control.
- **Client-side / handed-out key:** mint a **space-scoped key** per end-user and
  give it to that user's browser/app. The key physically cannot touch any other
  space or any management endpoint, so a leak is contained to one end-user.

---

## 1. Space-scoped API keys

### Create a scoped key

`POST /api/v1/auth/keys` — call this from your backend (with a JWT or an org-wide
key; a scoped key is **not** allowed to mint keys).

```jsonc
// Request
{
  "name": "enduser_A frontend key",
  "space_id": "0193f0c2-...-uuid-of-the-space",   // NEW, optional
  "expires_at": "2026-12-31T00:00:00Z"             // optional
}
```

```jsonc
// 201 Response
{
  "key_id": "…",
  "name": "enduser_A frontend key",
  "key_prefix": "csk_abcd",
  "raw_key": "csk_…full-secret…",   // shown ONCE — store/forward it now
  "expires_at": "2026-12-31T00:00:00Z",
  "space_id": "0193f0c2-...-uuid"    // null for an org-wide key
}
```

- Omit `space_id` → you get a normal **org-wide** key (unchanged legacy behavior).
- `space_id` must be a space in your active org, else `404 { detail: "Space … not found" }`.

### List keys

`GET /api/v1/auth/keys` now includes `space_id` on each item (`null` = org-wide):

```jsonc
{ "keys": [
  { "key_id": "…", "name": "…", "key_prefix": "csk_abcd", "is_active": true,
    "expires_at": null, "last_used_at": "…", "created_at": "…",
    "space_id": "0193f0c2-...-uuid" }   // NEW
]}
```

### What a scoped key can and cannot do

Use it exactly like any key: `Authorization: Bearer csk_…`.

**Allowed (data plane only):**
- `POST /api/v1/sources` — ingest (the body's `space_id` must equal the key's space)
- `POST /api/v1/conversations` — ingest conversations (same rule)
- `POST /api/v1/search` — search (body `space_id` must equal the key's space)
- `GET /api/v1/memories`, `/api/v1/entities`, `/api/v1/graph` — reads, pinned to its space
- `GET /api/v1/jobs/{id}` — poll ingestion status
- `GET /api/v1/spaces/{uuid}` and `/usage`, `GET /api/v1/auth/me`,
  `GET /api/v1/auth/keys/validate` — narrow self/space reads

**Blocked → `403`:**
- Creating/deleting spaces, **creating more keys** (no privilege escalation to an
  org-wide key), listing all spaces, org/billing/member management, org-level usage.
- Any data request that targets a **different** space than the key's →
  `403 { detail: "This API key is scoped to a different memory space." }`
- Any non-data endpoint →
  `403 { detail: "This API key is scoped to a single space and cannot access this endpoint." }`

So: mint scoped keys **server-side** with your org key, hand one to each end-user's
client. The client can read/write only that user's memory.

---

## 2. Per-space usage rollup

`GET /api/v1/spaces/{space_uuid}/usage` — tokens ingested + search queries for a
single space over a date range. This is the per-end-user attribution number.

```
GET /api/v1/spaces/0193f0c2-...-uuid/usage?start_date=2026-07-01&end_date=2026-07-31
```

- `start_date` / `end_date` are optional `YYYY-MM-DD`; default = current calendar month.
- `404` if the space isn't in your org. A scoped key may only read its own space.

```jsonc
// 200 Response
{
  "space_id": "0193f0c2-...-uuid",
  "period_start": "2026-07-01",
  "period_end": "2026-07-31",
  "tokens_ingested": 15230,
  "search_queries": 412
}
```

> Org-level totals + plan limits still live at `GET /api/v1/usage` (unchanged).
> This new endpoint is the per-space slice of the same underlying counters.

---

## End-to-end integration recipe (B2B2C)

Server-side, per new end-user:

1. **Create a space** — `POST /api/v1/spaces` with `{ "name": "enduser_<id>" }`.
   Store the returned `id` (UUID) against your user. (Names are unique per org, so
   this is also idempotent-ish: a duplicate name returns a quota/validation error
   you can treat as "already exists" by first `GET /api/v1/spaces?name=enduser_<id>`.)
2. *(Optional, for client-side use)* **Mint a scoped key** —
   `POST /api/v1/auth/keys` with that space's `space_id`. Forward `raw_key` to that
   user's client. Otherwise keep using your org key server-side.
3. **Ingest** — `POST /api/v1/sources` with `{ "space_id": "<that space>", "sources": [...] }`.
4. **Search** — `POST /api/v1/search` with `{ "space_id": "<that space>", "query": "…" }`.
5. **Bill/attribute** — `GET /api/v1/spaces/<that space>/usage` for the period.

---

## Backward compatibility & limits

- **Fully additive.** `space_id` on key create is optional; existing keys have
  `space_id: null` (org-wide) and behave exactly as before. The usage endpoint is
  new. No existing request shape changed.
- **Quota is still per-org.** All spaces share the org's monthly token quota and
  rate limits. Per-space *enforcement* (a hard cap per end-user) is a deliberate
  follow-up — this ships the per-space *visibility* (read) but not per-space limits.
- **Space cap still applies.** One-space-per-end-user counts against your plan's
  `max_memory_spaces`. High-volume B2B2C needs that cap raised — talk to us before
  scaling.
- **Scoped key + jobs:** a scoped key can poll any job UUID in its own org (job ids
  are unguessable UUIDs). It cannot read other orgs. Low risk; flagged for awareness.

---

## DB / migration note (backend)

Adds a nullable `api_keys.space_id` (FK → `memory_spaces`, `ON DELETE CASCADE`) +
index. Migration `0005_scoped_api_keys.sql`. Applied to prod out-of-band via psql
(the drizzle journal is behind prod for other tables — do **not**
`drizzle-kit migrate` this repo against prod). Existing rows are `NULL` = org-wide.
