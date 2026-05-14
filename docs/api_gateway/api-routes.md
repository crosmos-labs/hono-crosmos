# API Routes — Auth & Organizations

All routes use JSON request/response bodies unless noted. Authentication via `Authorization: Bearer <token>` header.

## Route Groups

| Prefix | Purpose | Auth |
|--------|---------|------|
| `/api/v1/auth` | Token management, API keys | Mixed |
| `/api/v1/auth/oauth` | OAuth consumer (Google login) | Public |
| `/oauth` | OAuth server (for MCP connectors) | Public |
| `/api/v1/orgs` | Organization management | JWT/API key |

---

## Auth Routes (`/api/v1/auth`)

### POST `/api/v1/auth/refresh`

Exchange refresh token for new token pair.

**Auth:** None (public)

**Request:**
```typescript
{
  refresh_token: string  // required
}
```

**Response (200):**
```typescript
{
  user_id: string        // UUID
  email: string
  name: string
  access_token: string
  refresh_token: string
  token_type: "bearer"
  active_org_id: string | null  // UUID
}
```

**Errors:**
- `401` — Token expired, revoked, or invalid
- `401` — User account inactive

---

### POST `/api/v1/auth/logout`

Revoke a refresh token.

**Auth:** None (public)

**Request:**
```typescript
{
  refresh_token: string  // required
}
```

**Response:** `204 No Content`

**Notes:** Idempotent — returns 204 even if token already revoked/expired.

---

### GET `/api/v1/auth/me`

Get current user profile.

**Auth:** JWT or API key

**Response (200):**
```typescript
{
  id: string      // UUID
  email: string
  name: string
}
```

---

### PATCH `/api/v1/auth/me`

Update current user profile.

**Auth:** JWT or API key

**Request:**
```typescript
{
  name?: string  // 1-255 chars, auto-trimmed
}
```

**Response (200):** Same as GET /me

---

### POST `/api/v1/auth/keys`

Create a new API key.

**Auth:** JWT or API key (requires org context)

**Request:**
```typescript
{
  name: string            // 1-255 chars, required
  expires_at?: string     // ISO datetime, optional
}
```

**Response (201):**
```typescript
{
  key_id: string      // UUID
  name: string
  key_prefix: string  // "csk_..."
  raw_key: string     // Full key, shown ONCE
  expires_at: string | null
}
```

**Notes:** Key is pinned to principal's current org.

---

### GET `/api/v1/auth/keys`

List all API keys for current user.

**Auth:** JWT or API key

**Response (200):**
```typescript
{
  keys: Array<{
    key_id: string        // UUID
    name: string
    key_prefix: string    // "csk_..."
    is_active: boolean
    expires_at: string | null
    last_used_at: string | null
    created_at: string
  }>
}
```

---

### DELETE `/api/v1/auth/keys/{key_uuid}`

Revoke an API key.

**Auth:** JWT or API key

**Path params:** `key_uuid` (UUID)

**Response:** `204 No Content`

**Errors:**
- `404` — Key not found or not owned by user

---

### GET `/api/v1/auth/keys/validate`

Validate an API key.

**Auth:** API key in Authorization header

**Response (200):**
```typescript
{
  valid: boolean
  key_prefix: string
}
```

**Errors:**
- `401` — Invalid, revoked, or expired key

---

## OAuth Consumer Routes (`/api/v1/auth/oauth`)

These handle user login via Google.

### GET `/api/v1/auth/oauth/providers`

List available OAuth providers.

**Auth:** None

**Response (200):**
```typescript
{
  providers: ["google"]
}
```

---

### GET `/api/v1/auth/oauth/{provider}/authorize`

Get OAuth authorization URL.

**Auth:** None

**Path params:** `provider` (e.g., "google")

**Query params:**
- `redirect_uri` (required) — Where to redirect after auth

**Response (200):**
```typescript
{
  authorization_url: string  // URL to redirect user to
  state: string              // Pass back in callback
}
```

---

### POST `/api/v1/auth/oauth/{provider}/callback`

Exchange OAuth code for tokens.

**Auth:** None

**Path params:** `provider`

**Request:**
```typescript
{
  code: string          // From provider
  state: string         // From authorize step
  redirect_uri: string  // Must match authorize
}
```

**Response (200):**
```typescript
{
  user_id: string
  email: string
  name: string
  access_token: string
  refresh_token: string
  token_type: "bearer"
  is_new_user: boolean
  default_space_id: string | null  // UUID, only for new users
  active_org_id: string | null     // UUID
}
```

**Side effects:**
- New user: Creates personal org + default memory space
- New user: Sends welcome email

---

## OAuth Server Routes (`/oauth`)

These implement an OAuth 2.1 authorization server for MCP connectors (e.g., Claude connector). Uses Google as identity provider.

### GET `/.well-known/oauth-authorization-server`

RFC 8414 metadata discovery.

**Auth:** None

**Response (200):**
```typescript
{
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint: string | null
  revocation_endpoint: string | null
  response_types_supported: ["code"]
  grant_types_supported: ["authorization_code", "refresh_token"]
  token_endpoint_auth_methods_supported: ["client_secret_post", "none"]
  code_challenge_methods_supported: ["S256"]
}
```

---

### POST `/oauth/register`

Dynamic client registration (RFC 7591).

**Auth:** None

**Request:**
```typescript
{
  redirect_uris?: string[]
  client_name?: string
  grant_types?: string[]      // default: ["authorization_code", "refresh_token"]
  response_types?: string[]   // default: ["code"]
  token_endpoint_auth_method?: string  // forced to "none" for MCP
}
```

**Response (200):**
```typescript
{
  client_id: string
  client_secret: string | null  // null for public clients
  client_id_issued_at: number   // Unix timestamp
  client_secret_expires_at: 0   // Never expires
  redirect_uris: string[]
  client_name: string | null
  grant_types: string[]
  response_types: string[]
  token_endpoint_auth_method: string
}
```

---

### GET `/oauth/authorize`

Start OAuth authorization flow.

**Auth:** None

**Query params:**
- `response_type` (required) — Must be "code"
- `client_id` (required)
- `redirect_uri` (required) — Must match registered URI
- `code_challenge` (required) — PKCE challenge
- `code_challenge_method` — Default "S256"
- `state` (optional) — Echoed back
- `scope` (optional)

**Response:** `302 Redirect` to Google OAuth

---

### GET `/oauth/callback`

Internal callback from Google (not called by clients).

**Query params:**
- `code` — From Google
- `state` — Our signed flow state

**Response:** `302 Redirect` to client's redirect_uri with `code` and `state`

---

### POST `/oauth/token`

Exchange code or refresh token for access token.

**Auth:** None

**Content-Type:** `application/x-www-form-urlencoded`

**Form params (authorization_code grant):**
```
grant_type=authorization_code
code=<auth_code>
redirect_uri=<must_match>
client_id=<client_id>
client_secret=<optional_for_public>
code_verifier=<pkce_verifier>
```

**Form params (refresh_token grant):**
```
grant_type=refresh_token
refresh_token=<token>
client_id=<client_id>
client_secret=<optional_for_public>
```

**Response (200):**
```typescript
{
  access_token: string
  token_type: "bearer"
  expires_in: number
  refresh_token: string | null
}
```

**Error Response (400/401):**
```typescript
{
  error: "invalid_grant" | "invalid_client" | "unsupported_grant_type"
  error_description?: string
}
```

---

## Organization Routes (`/api/v1/orgs`)

### GET `/api/v1/orgs`

List user's organizations.

**Auth:** JWT or API key

**Query params:**
- `limit` (optional) — 1-100, default 20

**Response (200):**
```typescript
{
  orgs: Array<{
    id: string            // UUID
    slug: string
    name: string
    plan: "free" | "developer" | "pro" | "enterprise"
    billing_email: string | null
    created_at: string
    updated_at: string
    member_count: number
    your_role: "owner" | "admin" | "member"
  }>
  next_cursor: string | null
}
```

---

### GET `/api/v1/orgs/{org_uuid}`

Get organization details.

**Auth:** JWT or API key (must be member)

**Path params:** `org_uuid` (UUID)

**Response (200):** Same as list item

**Errors:**
- `404` — Not found or not a member

---

### PATCH `/api/v1/orgs/{org_uuid}`

Update organization.

**Auth:** JWT or API key (requires owner/admin role)

**Path params:** `org_uuid` (UUID)

**Request:**
```typescript
{
  name?: string          // 1-255 chars
  slug?: string          // 1-64 chars, pattern: ^[a-z0-9][a-z0-9-]*[a-z0-9]$
  billing_email?: string // valid email
}
```

**Response (200):**
```typescript
{
  id: string
  slug: string
  name: string
  plan: string
  billing_email: string | null
  created_at: string
  updated_at: string
}
```

**Errors:**
- `403` — Insufficient role
- `409` — Slug already taken

---

### GET `/api/v1/orgs/{org_uuid}/entitlements`

Get organization entitlements and usage.

**Auth:** JWT or API key (must be member)

**Path params:** `org_uuid` (UUID)

**Response (200):**
```typescript
{
  plan: string
  entitlements: Record<string, any>
  usage_this_month: {
    tokens_ingested: number
    search_queries: number
  }
}
```

---

## Authentication Header Format

```
Authorization: Bearer <jwt_access_token>
Authorization: Bearer csk_a1b2c3d4e5f6...
```

The backend routes by token format:
- Starts with `csk_` → API key lookup
- Otherwise → JWT decode

---

## Error Response Format

All errors return JSON:

```typescript
{
  detail: string | {
    code: string
    message: string
  }
}
```

Common status codes:
- `400` — Validation error
- `401` — Unauthorized (invalid/expired token)
- `403` — Forbidden (insufficient role)
- `404` — Not found (or access denied to prevent enumeration)
- `409` — Conflict (e.g., slug collision)
