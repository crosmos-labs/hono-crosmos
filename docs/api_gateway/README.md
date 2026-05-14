# API Gateway Migration Documentation

This directory contains detailed migration specs for the **API Gateway** service — the Hono Worker that handles authentication, authorization, and user management.

## Reference: Parent Python Repo

> **The source of truth is the original Python implementation at `../crosmos-mem`.**
>
> These docs describe the target TypeScript/Hono implementation, but if anything is ambiguous, contradictory, or missing — **always refer back to the Python repo** at `../crosmos-mem`. The Python code is the authoritative reference for:
> - Exact business logic (token expiry rules, hashing algorithms, validation logic)
> - Edge case handling
> - SQL query patterns
> - Error response formats
> - Integration details (Polar, Resend, Google OAuth)
>
> When in doubt, grep the Python repo. The docs here are a summary, not a replacement.

## Scope

This documentation covers:
- **User management** — signup, profile, account linking
- **Multi-tenancy** — organizations, memberships, roles
- **Authentication** — JWT tokens, API keys, OAuth (Google)
- **OAuth Server** — OAuth 2.1 provider for MCP connectors (e.g., Claude connector)
- **Email** — Welcome emails via Resend (non-blocking)

## Documents

| File | Purpose |
|------|---------|
| [setup.md](./setup.md) | **Start here.** Wrangler config, env vars, local dev, deployment, Swagger UI |
| [database-schema.md](./database-schema.md) | Exact table definitions, columns, indexes, foreign keys |
| [api-routes.md](./api-routes.md) | All HTTP endpoints with request/response schemas |
| [services.md](./services.md) | Business logic — JWT handling, API key hashing, OAuth flows |

## Migration Order

1. **Database schema** — Port SQLAlchemy models to Drizzle. Run migrations against existing NeonDB.
2. **JWT utilities** — Port token creation/verification. Use `@tsndr/cloudflare-worker-jwt` or `jose`.
3. **API key validation** — Implement SHA-256 hashing + KV cache lookup.
4. **OAuth consumer** — Port Google OAuth flow.
5. **OAuth server** — Port authorization server routes (for Claude connector).
6. **Routes** — Port FastAPI routes to Hono handlers.

## Key Files (Current Python)

| Purpose | Python Path |
|---------|-------------|
| User & API key service | `app/services/auth/service.py` |
| JWT utilities | `app/services/auth/jwt.py` |
| OAuth server logic | `app/services/auth/oauth_server.py` |
| Auth dependencies | `app/api/auth/dependencies.py` |
| Auth routes | `app/api/auth/routes.py` |
| OAuth consumer routes | `app/api/auth/oauth/routes.py` |
| OAuth server routes | `app/api/auth/oauth/server_routes.py` |
| Google provider | `app/api/auth/oauth/google.py` |
| Organization service | `app/services/organizations/service.py` |
| Models | `app/models/auth/*.py`, `app/models/organizations.py` |

## Authentication Methods

The API Gateway supports **two authentication methods**:

### 1. JWT Tokens (User Sessions)
- Issued after OAuth login
- Access token: 7 days, carries `active_org_id` claim
- Refresh token: 30 days, has unique `jti` for revocation
- Algorithm: HS256

### 2. API Keys (Programmatic Access)
- Format: `csk_<32 hex chars>`
- Stored as SHA-256 hash
- Pinned to single organization at creation
- Optional expiration

## OAuth Flows

### OAuth Consumer (Google Login)
Standard OAuth 2.0 flow where we're the **client** and Google is the **provider**.

```
User → /auth/oauth/google/authorize → Google → /auth/oauth/google/callback → JWT pair
```

### OAuth Server (MCP Connectors)
OAuth 2.1 flow where we're the **provider** and external apps (e.g., Claude connector) are **clients**.

```
Claude → /oauth/authorize → Google (identity) → /oauth/callback → Client redirect_uri
Claude → /oauth/token → JWT pair
```

This uses Google as the identity source but issues our own tokens.

## Critical Implementation Notes

1. **API key format must match exactly**: `csk_` prefix + 32 hex chars
2. **SHA-256 hashing**: Use exact same algorithm for API keys and OAuth client secrets
3. **JWT claims**: Access tokens carry `active_org_id`, refresh tokens carry `jti`
4. **Org scoping**: API keys are pinned to one org; JWTs can switch via `active_org_id`
5. **Authorization codes**: 5-minute TTL, single-use, PKCE support
6. **Flow state**: Signed JWT for CSRF protection during OAuth redirect
