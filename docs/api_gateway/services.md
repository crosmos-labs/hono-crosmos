# Services — Auth Business Logic

This document covers the exact implementation of authentication services. **Match these exactly during migration.**

## JWT Token Service

**File:** `app/services/auth/jwt.py`

### Configuration

| Setting | Value | Notes |
|---------|-------|-------|
| Algorithm | HS256 | HMAC with SHA-256 |
| Access token TTL | 7 days | `jwt_access_token_expire_minutes = 10080` |
| Refresh token TTL | 30 days | `jwt_refresh_token_expire_days = 30` |
| Secret | `settings.jwt_secret` | From environment |

### Access Token Payload

```typescript
{
  sub: string              // user_id as string
  type: "access"
  iat: number              // issued at (Unix timestamp)
  exp: number              // expiration (Unix timestamp)
  active_org_id?: number   // optional, org context for request
}
```

### Refresh Token Payload

```typescript
{
  sub: string        // user_id as string
  type: "refresh"
  iat: number
  exp: number
  jti: string        // JWT ID, 16-byte URL-safe random
}
```

### Token Functions

```python
# Create access token
def create_access_token(
    user_id: int,
    *,
    active_org_id: int | None = None,
    expires_delta: timedelta | None = None
) -> str

# Create refresh token (includes jti)
def create_refresh_token(
    user_id: int,
    *,
    expires_delta: timedelta | None = None
) -> str

# Create both
def create_token_pair(
    user_id: int,
    *,
    active_org_id: int | None = None
) -> dict[str, str]  # {"access_token": ..., "refresh_token": ...}

# Decode and verify
def decode_token(token: str) -> dict[str, Any]
def decode_access_token(token: str) -> int  # returns user_id
def decode_refresh_token(token: str) -> int  # returns user_id

# Extract claims
def decode_access_token_claims(token: str) -> AccessTokenClaims
# Returns: {"user_id": int, "active_org_id": int | None}

def decode_refresh_token_claims(token: str) -> RefreshTokenClaims
# Returns: {"user_id": int, "jti": str, "expires_at": datetime}
```

### jti Generation

```python
import secrets
jti = secrets.token_urlsafe(16)  # 16 bytes = ~22 chars
```

---

## API Key Service

**File:** `app/services/auth/service.py`

### Key Format

```
Prefix:     csk_
Entropy:    32 hex chars (128 bits)
Full key:   csk_a1b2c3d4e5f67890abcdef1234567890
Prefix:     csk_a1b2c3d4 (first 12 chars, stored for display)
Hash:       SHA-256 hex digest of full key
```

### Key Generation

```python
import secrets
import hashlib

# Generate raw key
raw_key = f"csk_{secrets.token_hex(16)}"

# Compute hash for storage
key_hash = hashlib.sha256(raw_key.encode("utf-8")).hexdigest()

# Extract prefix for display
key_prefix = raw_key[:12]  # "csk_a1b2c3d4"
```

### Functions

```python
async def create_api_key(
    db: AsyncSession,
    *,
    user_id: int,
    org_id: int,
    name: str,
    expires_at: datetime | None = None
) -> tuple[ApiKey, str]
# Returns: (model, raw_key)
# raw_key shown once, only hash stored

async def resolve_api_key(
    db: AsyncSession,
    raw_key: str
) -> ApiKey | None
# Hash input, lookup by key_hash
# Returns None if not found or is_active=False

async def revoke_api_key(
    db: AsyncSession,
    *,
    user_id: int,
    key_id: int
) -> bool
# Sets is_active=False
# Validates ownership first

async def revoke_org_api_keys(
    db: AsyncSession,
    *,
    user_id: int,
    org_id: int
) -> int
# Bulk revoke when removing user from org

async def touch_api_key_last_used(
    db: AsyncSession,
    key_id: int
) -> None
# Update last_used_at on every authenticated request
```

### Validation Logic

```python
# In dependencies.py
async def _resolve_api_key_user(token: str, db: AsyncSession) -> User:
    api_key = await resolve_api_key(db, token)
    if api_key is None:
        raise HTTPException(401, "Invalid or revoked API key")
    
    # Check expiration
    if api_key.expires_at is not None:
        now = datetime.now(timezone.utc)
        if api_key.expires_at < now:
            raise HTTPException(401, "API key has expired")
    
    # Update last_used_at (fire and forget)
    await touch_api_key_last_used(db, api_key.id)
    
    return api_key.user
```

---

## Refresh Token Revocation

**File:** `app/services/auth/service.py`

### Functions

```python
async def revoke_refresh_token(
    db: AsyncSession,
    *,
    jti: str,
    user_id: int,
    expires_at: datetime
) -> None
# Add to blocklist (idempotent - checks if exists first)

async def is_refresh_token_revoked(
    db: AsyncSession,
    jti: str
) -> bool
# Check blocklist before issuing new tokens
```

### Revocation Table

```sql
revoked_refresh_tokens (
    jti VARCHAR(64) PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,  -- for cleanup
    revoked_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

---

## Auth Dependencies (FastAPI Middleware)

**File:** `app/api/auth/dependencies.py`

### Token Routing

```python
async def get_current_user(
    credentials: HTTPAuthorizationCredentials,
    db: AsyncSession
) -> User:
    token = credentials.credentials
    
    if token.startswith("csk_"):
        return await _resolve_api_key_user(token, db)
    else:
        return await _resolve_jwt_user(token, db)
```

### Principal (Org-Scoped Context)

```python
@dataclass(frozen=True)
class Principal:
    user: User
    org_id: int
    role: Literal["owner", "admin", "member"]
    member: OrganizationMember
    auth_method: Literal["jwt", "api_key"]
```

### Org Resolution

```python
async def get_current_principal(...) -> Principal:
    token = credentials.credentials
    
    if token.startswith("csk_"):
        # API key: org_id from key's pinned org
        api_key = await resolve_api_key(db, token)
        org_id = api_key.org_id
        auth_method = "api_key"
    else:
        # JWT: org_id from active_org_id claim
        claims = decode_access_token_claims(token)
        org_id = claims.get("active_org_id")
        if org_id is None:
            raise HTTPException(400, "no_org_context")
        auth_method = "jwt"
    
    # Verify membership
    member = await get_membership(db, org_id=org_id, user_id=user.id)
    if member is None:
        raise HTTPException(404, "Organization not found")
    
    return Principal(user, org_id, member.role, member, auth_method)
```

### Space Access Verification

```python
async def verify_space_access_scoped(
    space_id: int,
    principal: Principal,
    db: AsyncSession
) -> MemorySpace:
    space = await db.get(MemorySpace, space_id)
    if space is None or space.org_id != principal.org_id:
        raise HTTPException(404, "Space not found")
    return space
```

---

## Google OAuth Provider

**File:** `app/api/auth/oauth/google.py`

### Endpoints Called

| Purpose | URL |
|---------|-----|
| Authorization | `https://accounts.google.com/o/oauth2/v2/auth` |
| Token exchange | `https://oauth2.googleapis.com/token` |
| JWKS (public keys) | `https://www.googleapis.com/oauth2/v3/certs` |

### Authorization URL Params

```python
params = {
    "client_id": settings.google_client_id,
    "redirect_uri": redirect_uri,
    "response_type": "code",
    "scope": "openid email profile",
    "access_type": "offline",
    "prompt": "consent",
    "state": state,
}
```

### Token Exchange

```python
async def exchange_code(code: str, redirect_uri: str) -> OAuthUserInfo:
    # 1. Exchange code for tokens
    response = await httpx.post(
        "https://oauth2.googleapis.com/token",
        data={
            "client_id": settings.google_client_id,
            "client_secret": settings.google_client_secret,
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": redirect_uri,
        }
    )
    id_token = response.json()["id_token"]
    
    # 2. Fetch Google's public keys
    jwks = await httpx.get("https://www.googleapis.com/oauth2/v3/certs")
    
    # 3. Verify and decode id_token (RS256)
    payload = jwt.decode(
        id_token,
        jwks.json(),
        algorithms=["RS256"],
        audience=settings.google_client_id,
        issuer="https://accounts.google.com"
    )
    
    # 4. Extract user info
    return OAuthUserInfo(
        provider="google",
        provider_user_id=payload["sub"],
        email=payload["email"],
        name=payload.get("name", payload["email"].split("@")[0])
    )
```

### Account Linking Logic

```python
async def get_or_create_oauth_user(
    db: AsyncSession,
    *,
    provider: str,
    provider_id: str,
    email: str,
    name: str
) -> tuple[User, bool]:
    # 1. Try exact OAuth identity match
    user = await get_user_by_oauth(db, provider=provider, provider_id=provider_id)
    if user:
        return user, False
    
    # 2. Try email match (link OAuth to existing account)
    user = await get_user_by_email(db, email)
    if user:
        user.oauth_provider = provider
        user.oauth_provider_id = provider_id
        return user, False
    
    # 3. Create new user
    user = await create_user(
        db,
        email=email,
        name=name,
        oauth_provider=provider,
        oauth_provider_id=provider_id
    )
    return user, True
```

---

## OAuth Server (for MCP Connectors)

**File:** `app/services/auth/oauth_server.py`

This makes Crosmos an OAuth 2.1 **provider** for external apps like Claude connector.

### Constants

```python
AUTHORIZATION_CODE_LIFETIME = timedelta(minutes=5)
FLOW_STATE_LIFETIME = timedelta(minutes=10)
```

### Client Registration

```python
async def register_client(
    db: AsyncSession,
    *,
    redirect_uris: list[str],
    client_name: str | None = None,
    grant_types: list[str] | None = None,
    response_types: list[str] | None = None,
    token_endpoint_auth_method: str = "none"
) -> tuple[OAuthClient, str | None]:
    # Generate client_id
    client_id = secrets.token_urlsafe(24)
    
    # For confidential clients, generate secret
    if token_endpoint_auth_method != "none":
        client_secret = secrets.token_urlsafe(32)
        secret_hash = hashlib.sha256(client_secret.encode()).hexdigest()
    else:
        client_secret = None
        secret_hash = None
    
    client = OAuthClient(
        client_id=client_id,
        client_secret_hash=secret_hash,
        redirect_uris=redirect_uris,
        client_name=client_name,
        grant_types=grant_types or ["authorization_code", "refresh_token"],
        response_types=response_types or ["code"],
        token_endpoint_auth_method=token_endpoint_auth_method,
    )
    db.add(client)
    return client, client_secret
```

### Flow State (CSRF Protection)

```python
def create_flow_state(
    *,
    client_id: str,
    redirect_uri: str,
    code_challenge: str,
    code_challenge_method: str,
    state: str | None = None,
    scope: str | None = None
) -> str:
    # Encode all params in signed JWT
    payload = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "code_challenge": code_challenge,
        "code_challenge_method": code_challenge_method,
        "state": state,
        "scope": scope,
        "exp": datetime.utcnow() + FLOW_STATE_LIFETIME,
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")
```

### Authorization Code

```python
async def create_authorization_code(
    db: AsyncSession,
    *,
    client_id: str,
    user_id: int,
    redirect_uri: str,
    code_challenge: str,
    code_challenge_method: str = "S256",
    scope: str | None = None
) -> str:
    code = secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + AUTHORIZATION_CODE_LIFETIME
    
    auth_code = AuthorizationCode(
        code=code,
        client_id=client_id,
        user_id=user_id,
        redirect_uri=redirect_uri,
        code_challenge=code_challenge,
        code_challenge_method=code_challenge_method,
        scope=scope,
        expires_at=expires_at,
        used=False,
    )
    db.add(auth_code)
    return code
```

### Code Exchange

```python
async def exchange_authorization_code(
    db: AsyncSession,
    *,
    code: str,
    client_id: str,
    redirect_uri: str | None = None
) -> dict[str, str | int]:
    # 1. Lookup code
    auth_code = await db.get(AuthorizationCode, code)
    if not auth_code or auth_code.used:
        raise InvalidGrant()
    
    # 2. Validate
    if auth_code.client_id != client_id:
        raise InvalidGrant()
    if auth_code.expires_at < datetime.now(timezone.utc):
        raise InvalidGrant()
    if redirect_uri and auth_code.redirect_uri != redirect_uri:
        raise InvalidGrant()
    
    # 3. Mark as used
    auth_code.used = True
    
    # 4. Resolve active_org_id (earliest org membership)
    memberships = await get_org_memberships_for_user(db, auth_code.user_id)
    active_org_id = memberships[0].org_id if memberships else None
    
    # 5. Create token pair
    tokens = create_token_pair(auth_code.user_id, active_org_id=active_org_id)
    
    return {
        "access_token": tokens["access_token"],
        "token_type": "bearer",
        "expires_in": settings.jwt_access_token_expire_minutes * 60,
        "refresh_token": tokens["refresh_token"],
    }
```

---

## Organization Service

**File:** `app/services/organizations/service.py`

### Personal Org Creation (on signup)

```python
async def create_personal_org(
    db: AsyncSession,
    *,
    user_id: int,
    user_name: str,
    user_email: str | None = None
) -> tuple[Organization, OrganizationMember]:
    # Generate unique slug from name
    slug = await generate_unique_slug(db, user_name)
    
    org = Organization(
        slug=slug,
        name=f"{user_name}'s Space",
        is_personal=True,
        plan="free",
        billing_email=user_email,
        created_by_user_id=user_id,
    )
    db.add(org)
    await db.flush()  # Get org.id
    
    # Add user as owner
    member = OrganizationMember(
        org_id=org.id,
        user_id=user_id,
        role="owner",
    )
    db.add(member)
    
    return org, member
```

### Slug Generation

```python
async def generate_unique_slug(
    db: AsyncSession,
    name: str,
    max_retries: int = 5
) -> str:
    # Sanitize: lowercase, remove special chars
    base = re.sub(r"[^a-z0-9-]", "", name.lower())
    base = base[:58]  # Leave room for suffix
    
    for _ in range(max_retries):
        slug = f"{base}-{secrets.token_hex(3)}"  # 6 hex chars
        exists = await db.scalar(
            select(Organization).where(Organization.slug == slug)
        )
        if not exists:
            return slug
    
    raise SlugCollisionError()
```

### Member Removal (with key revocation)

```python
async def remove_member(
    db: AsyncSession,
    *,
    org_id: int,
    user_id: int
) -> None:
    member = await get_membership(db, org_id=org_id, user_id=user_id)
    if not member:
        raise OrganizationMemberNotFoundError()
    
    # Prevent removing last owner
    if member.role == "owner":
        owner_count = await db.scalar(
            select(func.count()).where(
                OrganizationMember.org_id == org_id,
                OrganizationMember.role == "owner"
            )
        )
        if owner_count <= 1:
            raise LastOwnerError()
    
    # Revoke all API keys for this user in this org
    await revoke_org_api_keys(db, user_id=user_id, org_id=org_id)
    
    # Remove membership
    await db.delete(member)
```

---

## Email Service (Resend)

**Used for:** Welcome emails on signup

### Current Implementation

In the OAuth callback, after creating a new user:

```python
# In oauth/routes.py callback
if is_new_user:
    # Fire and forget - don't block the response
    background_tasks.add_task(
        send_welcome_email,
        email=user.email,
        name=user.name
    )
```

### Resend Integration

```python
import resend

resend.api_key = settings.resend_api_key

async def send_welcome_email(email: str, name: str) -> None:
    resend.Emails.send({
        "from": "Crosmos <hello@crosmos.ai>",
        "to": email,
        "subject": "Welcome to Crosmos",
        "html": f"<p>Hi {name}, welcome to Crosmos!</p>"
    })
```

### Workers Migration

Use `ctx.waitUntil()` for non-blocking background work:

```typescript
// In Hono route handler
app.post('/auth/oauth/:provider/callback', async (c) => {
  const { user, isNew } = await handleOAuthCallback(c);
  
  if (isNew) {
    // Non-blocking: runs after response is sent
    c.executionCtx.waitUntil(
      sendWelcomeEmail(user.email, user.name)
    );
  }
  
  return c.json({ access_token, refresh_token, ... });
});

async function sendWelcomeEmail(email: string, name: string) {
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Crosmos <hello@crosmos.ai>',
      to: email,
      subject: 'Welcome to Crosmos',
      html: `<p>Hi ${name}, welcome to Crosmos!</p>`,
    }),
  });
}
```

**Key difference:** FastAPI uses `BackgroundTasks`, Workers uses `waitUntil()`. Both achieve the same result — response returns immediately, email sends in background.

---

## TypeScript Migration Notes

### JWT Library

Use `jose` or `@tsndr/cloudflare-worker-jwt`:

```typescript
import * as jose from 'jose';

const secret = new TextEncoder().encode(env.JWT_SECRET);

async function createAccessToken(userId: number, activeOrgId?: number) {
  return await new jose.SignJWT({
    sub: String(userId),
    type: 'access',
    active_org_id: activeOrgId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret);
}
```

### API Key Hashing

```typescript
async function hashApiKey(rawKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(rawKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
```

### Random Token Generation

```typescript
function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `csk_${hex}`;
}

function generateTokenUrlSafe(bytes: number): string {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}
```
