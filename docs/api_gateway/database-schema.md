# Database Schema — Auth & Multi-Tenancy

All tables are in the `public` schema. UUIDs use UUID v7 (`uuid_utils.compat.uuid7`).

## Tables Overview

| Table | Purpose |
|-------|---------|
| `users` | User accounts |
| `api_keys` | Programmatic access tokens |
| `oauth_clients` | Registered OAuth clients (for OAuth server) |
| `authorization_codes` | Short-lived OAuth auth codes |
| `revoked_refresh_tokens` | JWT refresh token blocklist |
| `organizations` | Tenant containers |
| `organization_members` | User-org membership with roles |
| `organization_invites` | Pending org invitations |
| `memory_spaces` | Data isolation within orgs |

---

## users

**File:** `app/models/auth/users.py`

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `id` | INTEGER | PRIMARY KEY | auto |
| `uuid` | UUID | UNIQUE, NOT NULL | uuid7() |
| `email` | VARCHAR(255) | UNIQUE, NOT NULL | |
| `name` | VARCHAR(255) | NOT NULL | |
| `oauth_provider` | VARCHAR(50) | NULL | |
| `oauth_provider_id` | VARCHAR(255) | NULL | |
| `is_active` | BOOLEAN | NOT NULL | true |
| `created_at` | TIMESTAMPTZ | NOT NULL | now() |
| `updated_at` | TIMESTAMPTZ | NOT NULL | now(), on update |

**Indexes:**
```sql
CREATE UNIQUE INDEX users_email_idx ON users(email);
CREATE INDEX users_created_at_idx ON users(created_at);
CREATE INDEX users_oauth_lookup_idx ON users(oauth_provider, oauth_provider_id);
```

**Constraints:**
```sql
ALTER TABLE users ADD CONSTRAINT uq_users_oauth_identity 
  UNIQUE (oauth_provider, oauth_provider_id);
```

---

## api_keys

**File:** `app/models/auth/api_keys.py`

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `id` | INTEGER | PRIMARY KEY | auto |
| `uuid` | UUID | UNIQUE, NOT NULL | uuid7() |
| `org_id` | INTEGER | FK → organizations.id, NOT NULL | |
| `user_id` | INTEGER | FK → users.id, NOT NULL | |
| `key_prefix` | VARCHAR(12) | NOT NULL | |
| `key_hash` | VARCHAR(64) | UNIQUE, NOT NULL | |
| `name` | VARCHAR(255) | NOT NULL | |
| `is_active` | BOOLEAN | NOT NULL | true |
| `expires_at` | TIMESTAMPTZ | NULL | |
| `last_used_at` | TIMESTAMPTZ | NULL | |
| `created_at` | TIMESTAMPTZ | NOT NULL | now() |
| `updated_at` | TIMESTAMPTZ | NOT NULL | now(), on update |

**Indexes:**
```sql
CREATE INDEX api_keys_user_id_idx ON api_keys(user_id);
CREATE INDEX api_keys_org_id_idx ON api_keys(org_id);
CREATE UNIQUE INDEX api_keys_key_hash_idx ON api_keys(key_hash);
CREATE INDEX api_keys_created_at_idx ON api_keys(created_at);
```

**Foreign Keys:**
```sql
ALTER TABLE api_keys ADD CONSTRAINT fk_api_keys_org_id 
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE api_keys ADD CONSTRAINT fk_api_keys_user_id 
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
```

**Key Format:**
- Raw key: `csk_<32 hex chars>` (128 bits entropy)
- `key_prefix`: First 12 chars (`csk_a1b2c3d4`)
- `key_hash`: SHA-256 hex digest of raw key

---

## oauth_clients

**File:** `app/models/auth/oauth_clients.py`

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `client_id` | VARCHAR(255) | PRIMARY KEY | |
| `client_secret_hash` | VARCHAR(64) | NULL | |
| `redirect_uris` | TEXT[] | NOT NULL | '{}' |
| `client_name` | VARCHAR(255) | NULL | |
| `grant_types` | TEXT[] | NOT NULL | '{authorization_code,refresh_token}' |
| `response_types` | TEXT[] | NOT NULL | '{code}' |
| `token_endpoint_auth_method` | VARCHAR(50) | NOT NULL | 'client_secret_post' |
| `created_at` | TIMESTAMPTZ | NOT NULL | now() |

**Indexes:**
```sql
CREATE INDEX oauth_clients_created_at_idx ON oauth_clients(created_at);
```

**Notes:**
- `client_id`: 24-byte URL-safe random string
- `client_secret_hash`: SHA-256 of secret (NULL for public clients)
- MCP proxy clients use `token_endpoint_auth_method = 'none'` (public + PKCE)

---

## authorization_codes

**File:** `app/models/auth/authorization_codes.py`

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `code` | VARCHAR(255) | PRIMARY KEY | |
| `client_id` | VARCHAR(255) | FK → oauth_clients.client_id, NOT NULL | |
| `user_id` | INTEGER | FK → users.id, NOT NULL | |
| `redirect_uri` | VARCHAR(2048) | NOT NULL | |
| `code_challenge` | VARCHAR(255) | NOT NULL | |
| `code_challenge_method` | VARCHAR(10) | NOT NULL | 'S256' |
| `scope` | VARCHAR(1024) | NULL | |
| `expires_at` | TIMESTAMPTZ | NOT NULL | |
| `used` | BOOLEAN | NOT NULL | false |
| `created_at` | TIMESTAMPTZ | NOT NULL | now() |

**Indexes:**
```sql
CREATE INDEX authorization_codes_client_id_idx ON authorization_codes(client_id);
CREATE INDEX authorization_codes_expires_at_idx ON authorization_codes(expires_at);
```

**Foreign Keys:**
```sql
ALTER TABLE authorization_codes ADD CONSTRAINT fk_auth_codes_client_id 
  FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE;
ALTER TABLE authorization_codes ADD CONSTRAINT fk_auth_codes_user_id 
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
```

**Notes:**
- `code`: 32-byte URL-safe random string
- TTL: 5 minutes
- Single-use: `used` set to true after exchange

---

## revoked_refresh_tokens

**File:** `app/models/auth/revoked_refresh_tokens.py`

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `jti` | VARCHAR(64) | PRIMARY KEY | |
| `user_id` | INTEGER | FK → users.id, NOT NULL | |
| `expires_at` | TIMESTAMPTZ | NOT NULL | |
| `revoked_at` | TIMESTAMPTZ | NOT NULL | now() |

**Indexes:**
```sql
CREATE INDEX revoked_refresh_tokens_expires_at_idx ON revoked_refresh_tokens(expires_at);
```

**Foreign Keys:**
```sql
ALTER TABLE revoked_refresh_tokens ADD CONSTRAINT fk_revoked_tokens_user_id 
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
```

**Notes:**
- `jti`: JWT ID from refresh token (16-byte URL-safe random)
- Rows can be pruned once `expires_at` passes

---

## organizations

**File:** `app/models/organizations.py`

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `id` | INTEGER | PRIMARY KEY | auto |
| `uuid` | UUID | UNIQUE, NOT NULL | uuid7() |
| `slug` | VARCHAR(64) | UNIQUE, NOT NULL | |
| `name` | VARCHAR(255) | NOT NULL | |
| `plan` | plan_type ENUM | NOT NULL | 'free' |
| `is_personal` | BOOLEAN | NOT NULL | false |
| `entitlements` | JSONB | NULL | |
| `posthog_flag_overrides` | JSONB | NULL | |
| `billing_email` | VARCHAR(255) | NULL | |
| `polar_customer_id` | VARCHAR(64) | UNIQUE, NULL | |
| `polar_subscription_id` | VARCHAR(64) | NULL | |
| `subscription_status` | subscription_status_type ENUM | NOT NULL | 'none' |
| `current_period_end` | TIMESTAMPTZ | NULL | |
| `plan_pending` | VARCHAR(32) | NULL | |
| `created_by_user_id` | INTEGER | FK → users.id, NULL | |
| `created_at` | TIMESTAMPTZ | NOT NULL | now() |
| `updated_at` | TIMESTAMPTZ | NOT NULL | now(), on update |

**Enums:**
```sql
CREATE TYPE plan_type AS ENUM ('free', 'developer', 'pro', 'enterprise');
CREATE TYPE subscription_status_type AS ENUM ('none', 'active', 'past_due', 'canceled', 'revoked');
```

**Indexes:**
```sql
CREATE UNIQUE INDEX organizations_slug_idx ON organizations(slug);
CREATE INDEX organizations_plan_idx ON organizations(plan);
CREATE INDEX organizations_created_at_idx ON organizations(created_at);
```

**Foreign Keys:**
```sql
ALTER TABLE organizations ADD CONSTRAINT fk_orgs_created_by 
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
```

---

## organization_members

**File:** `app/models/organizations.py`

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `id` | INTEGER | PRIMARY KEY | auto |
| `uuid` | UUID | UNIQUE, NOT NULL | uuid7() |
| `org_id` | INTEGER | FK → organizations.id, NOT NULL | |
| `user_id` | INTEGER | FK → users.id, NOT NULL | |
| `role` | org_role_type ENUM | NOT NULL | |
| `invited_by_user_id` | INTEGER | FK → users.id, NULL | |
| `joined_at` | TIMESTAMPTZ | NOT NULL | now() |
| `created_at` | TIMESTAMPTZ | NOT NULL | now() |
| `updated_at` | TIMESTAMPTZ | NOT NULL | now(), on update |

**Enum:**
```sql
CREATE TYPE org_role_type AS ENUM ('owner', 'admin', 'member');
```

**Indexes:**
```sql
CREATE INDEX org_members_user_id_idx ON organization_members(user_id);
CREATE INDEX org_members_org_role_idx ON organization_members(org_id, role);
```

**Constraints:**
```sql
ALTER TABLE organization_members ADD CONSTRAINT uq_org_members_org_user 
  UNIQUE (org_id, user_id);
```

**Foreign Keys:**
```sql
ALTER TABLE organization_members ADD CONSTRAINT fk_members_org_id 
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE organization_members ADD CONSTRAINT fk_members_user_id 
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE organization_members ADD CONSTRAINT fk_members_invited_by 
  FOREIGN KEY (invited_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
```

---

## organization_invites

**File:** `app/models/organizations.py`

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `id` | INTEGER | PRIMARY KEY | auto |
| `uuid` | UUID | UNIQUE, NOT NULL | uuid7() |
| `org_id` | INTEGER | FK → organizations.id, NOT NULL | |
| `email` | VARCHAR(255) | NOT NULL | |
| `role` | org_role_type ENUM | NOT NULL | 'member' |
| `token_hash` | VARCHAR(64) | UNIQUE, NOT NULL | |
| `invited_by` | INTEGER | FK → users.id, NOT NULL | |
| `expires_at` | TIMESTAMPTZ | NOT NULL | now() + interval '7 days' |
| `accepted_at` | TIMESTAMPTZ | NULL | |
| `created_at` | TIMESTAMPTZ | NOT NULL | now() |

**Indexes:**
```sql
CREATE INDEX org_invites_org_id_idx ON organization_invites(org_id);
CREATE UNIQUE INDEX org_invites_token_hash_idx ON organization_invites(token_hash);
CREATE UNIQUE INDEX uq_org_invites_pending ON organization_invites(org_id, email) 
  WHERE accepted_at IS NULL;
```

**Foreign Keys:**
```sql
ALTER TABLE organization_invites ADD CONSTRAINT fk_invites_org_id 
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE organization_invites ADD CONSTRAINT fk_invites_invited_by 
  FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE CASCADE;
```

---

## memory_spaces

**File:** `app/models/memory_spaces.py`

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `id` | INTEGER | PRIMARY KEY | auto |
| `uuid` | UUID | UNIQUE, NOT NULL | uuid7() |
| `org_id` | INTEGER | FK → organizations.id, NOT NULL | |
| `name` | VARCHAR(255) | NOT NULL | |
| `user_id` | INTEGER | FK → users.id, NOT NULL | |
| `description` | TEXT | NULL | |
| `meta` | JSONB | NULL | |
| `created_at` | TIMESTAMPTZ | NOT NULL | now() |
| `updated_at` | TIMESTAMPTZ | NOT NULL | now(), on update |

**Indexes:**
```sql
CREATE INDEX memory_spaces_name_idx ON memory_spaces(name);
CREATE INDEX memory_spaces_user_id_idx ON memory_spaces(user_id);
CREATE INDEX memory_spaces_org_id_idx ON memory_spaces(org_id);
CREATE INDEX memory_spaces_created_at_idx ON memory_spaces(created_at);
```

**Constraints:**
```sql
ALTER TABLE memory_spaces ADD CONSTRAINT uq_memory_spaces_org_id_name 
  UNIQUE (org_id, name);
```

**Foreign Keys:**
```sql
ALTER TABLE memory_spaces ADD CONSTRAINT fk_spaces_org_id 
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE memory_spaces ADD CONSTRAINT fk_spaces_user_id 
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
```

---

## Entity Relationship Diagram

```
users
  │
  ├──< api_keys (user_id, org_id)
  ├──< organization_members (user_id)
  ├──< memory_spaces (user_id)
  ├──< authorization_codes (user_id)
  ├──< revoked_refresh_tokens (user_id)
  └──○ organizations (created_by_user_id)

organizations
  │
  ├──< organization_members (org_id)
  ├──< organization_invites (org_id)
  ├──< memory_spaces (org_id)
  └──< api_keys (org_id)

oauth_clients
  │
  └──< authorization_codes (client_id)
```

**Legend:** `<` = one-to-many, `○` = nullable FK

---

## Cascade Behavior

| Parent Delete | Cascades To |
|---------------|-------------|
| `users` | api_keys, organization_members, memory_spaces, authorization_codes, revoked_refresh_tokens |
| `organizations` | organization_members, organization_invites, memory_spaces, api_keys |
| `oauth_clients` | authorization_codes |

**SET NULL on delete:**
- `organizations.created_by_user_id`
- `organization_members.invited_by_user_id`
