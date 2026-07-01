# Billing & Subscriptions — Frontend Integration (KT)

How to integrate the Crosmos payment / subscription flow from the frontend. Covers
every endpoint, the subscription lifecycle, the async webhook timing you **must**
account for, and the error cases the UI has to handle.

- **Provider:** [Polar](https://polar.sh). All card data and the hosted checkout
  live on Polar — **no payment details ever touch our API or the frontend.** We
  only ever hand the user a Polar URL to redirect to.
- **Prod base URL:** `https://api.crosmos.dev`
- **Staging base URL:** `https://staginghono.crosmos.dev`
- All billing endpoints are mounted under **`/api/v1/billing`**.

---

## 1. Auth model

Every billing endpoint except the public plan catalog requires a bearer token:

```
Authorization: Bearer <token>
```

The token is either a **session JWT** or an **API key** — same header either way.
Billing actions operate on the caller's **active organization** (resolved from the
token); there is no org id in the billing URLs.

Role requirements:

| Endpoint | Required role |
|---|---|
| `GET /billing/plans` | none (public) |
| `GET /billing/subscription` | `owner` or `admin` |
| `POST /billing/checkout` | `owner` |
| `POST /billing/portal` | `owner` |
| `POST /billing/cancel` | `owner` |

A wrong/missing role returns **403** `{ "detail": "insufficient_role" }`. Hide the
checkout / cancel / portal buttons for non-owners.

---

## 2. Error response shape

All errors share one envelope (from the global handler):

```json
{
  "detail": "human/machine string",
  "code": "optional_machine_code",
  "request_id": "uuid"
}
```

For billing endpoints the meaningful field is **`detail`** (a stable string you can
switch on). Every response also carries an `X-Request-Id` header — log it; it makes
support tickets traceable. Full code table in §8.

---

## 3. The plan model

Four plans. Only **`developer`** and **`pro`** are purchasable through checkout.
`free` is the default; `enterprise` is "contact sales" (`status: "coming_soon"`).

| plan | price_usd | memory spaces | monthly tokens | monthly queries |
|---|---|---|---|---|
| free | 0 | 3 | 500,000 | 5,000 |
| developer | 19 | 7 | 5,000,000 | 50,000 |
| pro | 299 | 50 | 80,000,000 | 300,000 |
| enterprise | 0 (sales) | unlimited | unlimited | unlimited |

Don't hardcode these — read them from `GET /billing/plans` so price/quota changes
don't require a frontend deploy. `-1` in any numeric field means **unlimited**.

---

## 4. Subscription lifecycle

The org carries a `plan` **and** a `subscription_status`. **Access/entitlements are
driven by `plan` only** — `subscription_status` is informational for the UI.

`subscription_status` values:

| status | meaning | has paid access? | what the UI should show |
|---|---|---|---|
| `none` | never subscribed | no (on free) | "Upgrade" CTA |
| `active` | subscribed & paid, renewing | yes | "Pro · renews {current_period_end}" |
| `past_due` | a renewal payment failed; Polar is retrying | yes (during dunning) | warning banner: "Payment failed — update your card" → portal |
| `canceled` | user canceled; **runs until period end, no refund** | yes, until `current_period_end` | "Pro · ends {current_period_end}" + "Resume" → portal |
| `revoked` | subscription ended; downgraded to `free` | no | "Upgrade" CTA |

`plan_pending` (string | null): set to the plan the user is checking out for, between
the moment they start checkout and the moment the webhook activates it. Use it to
show a "Upgrade to {plan_pending} pending…" state on the success page.

State transitions you'll observe:

```
none ──checkout+pay──▶ active ──cancel──▶ canceled ──period end──▶ revoked ─▶ free
                         │  ▲                                                  │
                  payment│  │payment fixed (portal)                           │
                    fails│  │                                                  │
                         ▼  │                                                  │
                      past_due ──────────────────────────────────────────────┘
                                          (grace period elapses)
```

> **Cancellation policy (important):** canceling is **cancel-at-period-end**. We do
> **not** refund. The user keeps full paid access until `current_period_end`, then
> drops to `free`. The UI must communicate "you keep access until X" — never imply
> an instant downgrade or a refund.

---

## 5. Endpoint reference

### 5.0 Prerequisite — set `billing_email`

Checkout **requires** the org to have a `billing_email` (Polar invoices go there).
If it's missing, checkout fails with `400 billing_email is not set on organization`.
Set it via the org update endpoint before showing the upgrade flow:

```
PATCH /api/v1/orgs/{org_uuid}        (role: owner/admin)
Content-Type: application/json

{ "billing_email": "billing@acme.com" }
```

You can read the current value from `GET /api/v1/orgs/` (the `billing_email` field).

---

### 5.1 List plans — `GET /billing/plans`

Public, no auth. Use to render the pricing table.

```bash
curl https://api.crosmos.dev/api/v1/billing/plans
```

```json
{
  "plans": [
    { "plan": "free", "price_usd": 0, "max_memory_spaces": 3,
      "monthly_tokens_ingested": 500000, "monthly_search_queries": 5000, "status": "live" },
    { "plan": "developer", "price_usd": 19, "max_memory_spaces": 7,
      "monthly_tokens_ingested": 5000000, "monthly_search_queries": 50000, "status": "live" },
    { "plan": "pro", "price_usd": 299, "max_memory_spaces": 50,
      "monthly_tokens_ingested": 80000000, "monthly_search_queries": 300000, "status": "live" },
    { "plan": "enterprise", "price_usd": 0, "max_memory_spaces": -1,
      "monthly_tokens_ingested": -1, "monthly_search_queries": -1, "status": "coming_soon" }
  ]
}
```

---

### 5.2 Get current subscription — `GET /billing/subscription`

Role: `owner`/`admin`. The source of truth for what to render in billing settings.

```json
{
  "plan": "pro",
  "subscription_status": "active",
  "current_period_end": "2026-07-26T00:00:00.000Z",
  "plan_pending": null
}
```

`current_period_end` is ISO-8601 or `null`. Poll this after checkout/cancel (see §6).

---

### 5.3 Start checkout — `POST /billing/checkout`

Role: `owner`. Creates a Polar checkout session and returns its URL. **Redirect the
user to `checkout_url`.**

```bash
curl -X POST https://api.crosmos.dev/api/v1/billing/checkout \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "plan": "pro" }'
```

Request body: `{ "plan": "developer" | "pro" }`

`201` response:

```json
{ "checkout_url": "https://polar.sh/checkout/..." }
```

Then: `window.location.href = checkout_url`.

**Checkout only works when there is NO live subscription.** If the org already has a
live subscription (`active` / `past_due` / `canceled`), checkout returns
`400 existing_subscription_must_be_managed_in_portal`. **Plan changes
(upgrade / downgrade / resume) go through the portal (§5.4), not a new checkout** —
this is deliberate: a second checkout would create a second parallel Polar
subscription and double-charge. So:

- org on `free` / `none` / `revoked` → show **"Upgrade"** → checkout.
- org with a live sub → show **"Manage subscription"** → portal.

After Polar completes, the user is redirected to our success URL
(`{APP_BASE_URL}/billing/success` unless overridden). Activation is **asynchronous**
(see §6) — the success page must poll, not assume.

Errors: `400` (validation / no billing_email / already has live sub), `429`
(rate limited, max **5/hour**), `502` (`checkout_provider_error`).

---

### 5.4 Open customer portal — `POST /billing/portal`

Role: `owner`. Returns a Polar-hosted portal URL where the user can update their
card, change/cancel the plan, and see invoices. Redirect them to it.

```json
{ "portal_url": "https://polar.sh/portal/..." }
```

Use this as the **"Manage subscription"** button for any org that has a customer on
file. If the org has never had a subscription, it returns
`400 no_customer_on_file` — fall back to the checkout flow.

Errors: `400` (`no_customer_on_file`), `429` (max **10/hour**), `502`
(`portal_provider_error`).

---

### 5.5 Cancel subscription — `POST /billing/cancel`

Role: `owner`. Schedules cancel-at-period-end on Polar and flips local status to
`canceled`. **No refund. Access continues until `current_period_end`.** No request
body.

`200` response:

```json
{ "cancel_at_period_end": true, "subscription_status": "canceled" }
```

UX: confirm with the user that they keep access until `current_period_end`, then call
this, then re-fetch `GET /billing/subscription` to show the new `canceled` state.
To **un-cancel / resume** before the period ends, send them to the portal (§5.4).

Errors:
- `400 no_active_subscription` — nothing to cancel.
- `400 subscription_already_canceled` — already `canceled`/`revoked`.
- `429` — rate limited (max **5/hour**).
- `502 cancel_provider_error` — Polar call failed; safe to retry.

> The cancel endpoint and the portal can both cancel. They converge to the same
> `canceled` state via webhooks, so it's fine to offer either.

---

## 6. The async-activation gotcha (read this)

**Checkout and cancel results land via Polar webhooks, not synchronously.** When the
user returns from the Polar checkout to our success page, the `subscription.created`
/ `order.paid` webhook may not have been processed yet — so `GET /billing/subscription`
can still read the *old* plan for a few seconds.

Do **not** assume success from the redirect. On the success page, **poll**:

```ts
async function waitForActivation(expectedPlan: string, signal: AbortSignal) {
  for (let i = 0; i < 15; i++) {                 // ~30s budget
    const sub = await getSubscription();          // GET /billing/subscription
    if (sub.plan === expectedPlan && sub.subscription_status === 'active') {
      return sub;                                 // activated
    }
    if (signal.aborted) return null;
    await new Promise((r) => setTimeout(r, 2000)); // 2s between polls
  }
  return null; // still pending — show "we're finalizing your upgrade" + support link
}
```

`plan_pending` tells you an upgrade is in flight; it clears to `null` once activated.
Same idea after cancel: re-fetch until `subscription_status === 'canceled'`.

Webhook processing is idempotent and ordering-safe on the backend, so transient
delays resolve on their own — the only frontend job is to poll instead of trusting
the redirect.

---

## 7. Recommended UI flows

**Upgrade (free → paid)**
1. Ensure `billing_email` is set (§5.0); prompt if missing.
2. `POST /billing/checkout { plan }` → redirect to `checkout_url`.
3. On return to `/billing/success`, poll `GET /billing/subscription` (§6).
4. Show the active plan.

**Change card / view invoices / change plan / resume**
1. `POST /billing/portal` → redirect to `portal_url`.
2. On return, poll `GET /billing/subscription` to reflect any change.

**Cancel**
1. Confirm ("keep access until {current_period_end}, no refund").
2. `POST /billing/cancel`.
3. Re-fetch subscription → show `canceled` + end date + "Resume" (portal).

**Resubscribe after it lapsed (`revoked` / `free`)**
- Treat like a fresh upgrade → checkout.

---

## 8. Error code reference (`detail` strings)

| HTTP | `detail` | Where | Frontend action |
|---|---|---|---|
| 400 | `billing_email is not set on organization` | checkout | Prompt for billing email (§5.0), retry |
| 400 | `existing_subscription_must_be_managed_in_portal` | checkout | Route user to portal instead |
| 400 | `no_customer_on_file` | portal | Fall back to checkout |
| 400 | `no_active_subscription` | cancel | Hide cancel button (nothing to cancel) |
| 400 | `subscription_already_canceled` | cancel | Refresh state; already canceled |
| 403 | `insufficient_role` | all (owner-gated) | Hide control for non-owners |
| 401 | `unauthorized` | all authed | Re-auth |
| 429 | `rate_limited:checkout` / `:portal` / `:cancel` | resp. | Back off; show "try again shortly" |
| 502 | `checkout_provider_error` / `portal_provider_error` / `cancel_provider_error` | resp. | Transient Polar error; offer retry |

Rate limits (per org): checkout **5/hr**, portal **10/hr**, cancel **5/hr**.

---

## 9. Notes & non-goals

- **Webhooks (`POST /webhooks/polar`) are server-to-server only** — Polar → our API,
  HMAC-signed. The frontend never calls them and should never need to.
- **Entitlement enforcement is server-side.** Quota/seat errors surface from the
  feature endpoints (e.g. ingestion/search return `429` with a quota message), not
  from billing. The frontend should surface those and link to upgrade, but doesn't
  enforce limits itself.
- **No payment data on our side** — never collect card details; always redirect to
  the Polar `checkout_url` / `portal_url`.
- Test against **staging** (`staginghono.crosmos.dev`, Polar sandbox) before prod.

---

_Backend reference: `apps/api/src/features/billing/` (`routes.ts`, `service.ts`,
`webhooks.ts`, `schemas.ts`). Entitlements: `apps/api/src/features/orgs/entitlements.ts`._
