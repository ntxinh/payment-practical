# Stripe Subscriptions — Purpose Learning

Date: 2026-10-17
Status: Approved design, pre-implementation

## Goal

A minimal Next.js app that sells learning-plan subscriptions via Stripe:

1. User picks a plan on `/pricing`.
2. Server action creates a Stripe Checkout Session (`mode: "subscription"`).
3. User is redirected to Stripe Checkout.
4. `checkout.session.completed` webhook activates the subscription.
5. Subscription status lives in the local database.
6. `/account/billing` offers a Stripe Customer Portal redirect.
7. TypeScript types and explicit error codes throughout.

Product name/theme: "purpose learning". Subscription slice only — no gated
content, no learning features.

## Stack

Mirrors `../ecommerce`, trimmed:

- Next.js 16 (App Router), React 19, TypeScript strict
- better-sqlite3 + drizzle-orm (Postgres-portable schema)
- stripe (official SDK)
- ulidx (IDs), server-only, zod not required (formData + code paths only)
- Biome (lint/format), Vitest (unit + integration), tsx (scripts)
- pnpm 9 via mise (node 22)

Deliberately absent vs the reference: tailwind/shadcn, next-intl, pino,
argon2, Playwright, zod-contracts, permissions layer. Plain CSS; dev-only
auth makes those unjustified.

## Architecture

Modular monolith. Dependency direction:

```
app → features → server/modules → server/db
```

- Every `src/server/**` file starts with `import "server-only";`.
- Route handlers and server actions only parse → authorize → delegate →
  serialize. Business rules live in `src/server/modules/billing/**`.
- Modules expose service functions; no cross-import of schema internals
  outside `server/db`.

### File map

```
src/
  app/
    layout.tsx, page.tsx, globals.css
    login/page.tsx
    pricing/page.tsx
    account/billing/page.tsx
    api/v1/webhooks/stripe/route.ts
  features/
    auth/actions.ts        — login(email), logout()
    billing/actions.ts     — createCheckoutSession, createPortalSession
  server/
    env.ts                 — process.env accessors, dev defaults
    db/client.ts           — better-sqlite3 + drizzle, WAL, foreign_keys=ON
    db/schema.ts           — users, plans, subscriptions, webhook_events
    auth/session.ts        — cookie sign/verify, getCurrentUser()
    modules/billing/
      plans.ts             — plan queries
      subscriptions.ts     — upsert/status mapping/access check
      stripe.ts            — getStripe(), session + portal creation,
                             processBillingEvent(), handleStripeWebhook()
scripts/
  db-migrate.ts, db-seed.ts, stripe-seed.ts
tests/
  unit/, integration/, server-only.stub.ts
data/app.db                — gitignored
```

## Data model

Money: integer cents, `_cents` suffix. Timestamps: unixepoch milliseconds,
`_at` suffix. IDs: text ULIDs. FKs explicit; WAL + `foreign_keys=ON` in
`client.ts`. No SQLite-isms in services.

| table | columns |
|---|---|
| `users` | `id` text PK, `email` text unique not null, `stripe_customer_id` text nullable, `created_at` int not null |
| `plans` | `id` text PK, `slug` text unique, `name` text, `price_cents` int, `currency` text, `interval` text (`"month"`/`"year"`), `stripe_price_id` text nullable, `active` int (0/1), `created_at` int |
| `subscriptions` | `id` text PK, `user_id` text FK→users, `stripe_subscription_id` text unique, `stripe_price_id` text, `status` text, `current_period_end` int nullable, `cancel_at_period_end` int, `created_at`/`updated_at` int |
| `webhook_events` | `stripe_event_id` text PK, `type` text, `processed_at` int |

`subscriptions.stripe_subscription_id` unique gives idempotent upserts;
`webhook_events` PK insert-before-processing gives event idempotency.

## Auth

Dev-only email login — no passwords:

- `POST`-form server action `login(email)` → find-or-create user by email →
  set cookie `session = <userId>.<hmacSHA256(userId, SESSION_SECRET)>`,
  httpOnly, sameSite=lax, path=/.
- `getCurrentUser()` verifies the HMAC (timing-safe compare), returns the
  user row or `null`; pages redirect to `/login` when null.
- `SESSION_SECRET` from env with a documented dev default; README warns it
  is not production auth.

## Billing flow

```mermaid
sequenceDiagram
  actor U as User
  participant App as Next app
  participant S as Stripe
  U->>App: POST /login (email)
  App->>U: Set-Cookie session=uid.hmac
  U->>App: /pricing → createCheckoutSession(planId)
  App->>S: customers get-or-create; checkout.sessions.create(mode=subscription)
  S-->>U: 303 → Checkout
  S->>App: POST /api/v1/webhooks/stripe (checkout.session.completed)
  App->>App: verify signature → webhook_events dedupe → upsert subscription
  S->>App: customer.subscription.updated / .deleted
  App->>App: map Stripe status → subscriptions row
  U->>App: createPortalSession()
  App->>S: billingPortal.sessions.create → 303
```

The webhook handles **three** events — `checkout.session.completed`,
`customer.subscription.updated`, `customer.subscription.deleted` — because
the Customer Portal lets users cancel/switch without touching our checkout;
without these, the local status would drift from Stripe's truth.

### Checkout session creation

- Requires authenticated user (`UNAUTHENTICATED` otherwise).
- `stripe_customer_id` reused if present; otherwise created and persisted
  before the session (never recreated).
- `mode: "subscription"`, `line_items: [{price: plan.stripe_price_id}]`,
- The action calls `redirect(session.url)` server-side; no client JS
  involved. `NEXT_REDIRECT` propagates through the form POST.
  `success_url → /account/billing?success=1`,
  `cancel_url → /pricing`, `client_reference_id: user.id`,
  `metadata.userId` and `subscription_data.metadata.userId` set so the
  webhook resolves the user without a session retrieve.
- Action returns `{url}`; client-side `redirect()` or the action calls
  `redirect()` directly after URL creation.

### Webhook route

- `POST /api/v1/webhooks/stripe`: `payload = await req.text()`,
  `signature = headers.get("stripe-signature")`.
- 404 unless `STRIPE_WEBHOOK_SECRET` configured; 400 on
  `constructEvent` failure; 200 ack `{data:{received:true}}` for
  handled, duplicate, and unknown events.
- Event routing in `processBillingEvent(db, event)`:
  - `checkout.session.completed` → upsert subscription from the expanded
    subscription (or retrieve by `session.subscription`), status mapped.
  - `customer.subscription.updated` → upsert by `stripe_subscription_id`.
  - `customer.subscription.deleted` → set `status="canceled"`.
  - everything else → `IGNORED`, still 200.

### Customer portal

- `createPortalSession()` — auth-required; looks up
  `user.stripe_customer_id`; `NO_STRIPE_CUSTOMER` error when absent;
  `return_url → /account/billing`.

## Types & errors

```ts
type SubscriptionStatus =
  | "active" | "trialing" | "past_due" | "canceled" | "paused"
  | "incomplete" | "incomplete_expired" | "unpaid";

const isActive = (s: SubscriptionStatus) => s === "active" || s === "trialing";
```

Status mapping covers every `Stripe.Subscription["status"]`; unknown future
values map to `"unpaid"` conservatively (never grant access on an unknown
status).

`BillingError` carries a machine code:

| code | when |
|---|---|
| `UNAUTHENTICATED` | no valid session cookie |
| `PLAN_NOT_FOUND` | planId missing/inactive/no `stripe_price_id` |
| `STRIPE_NOT_CONFIGURED` | `STRIPE_SECRET_KEY` absent |
| `NO_STRIPE_CUSTOMER` | portal requested before any checkout |

Actions redirect to `?error=<code>`; pages render the code as a short line.
Route handler errors use `{error: CODE}` + HTTP status, mirroring the
reference webhook route.

## Plans & seeding

- `stripe-seed.ts` creates Stripe Products+Prices via the API (idempotent
  by metadata slug lookup), then upserts `plans` rows with the returned
  `stripe_price_id`.
- Initial catalog (edit in script): `starter` — Starter, $9.00/mo;
  `pro` — Pro, $29.00/mo. USD cents.
- `db-seed.ts` inserts the plan rows with null `stripe_price_id` so the UI
  renders before Stripe seeding (plan shows unavailable until seeded).

## Environment

`.env` (gitignored) already has `STRIPE_SECRET_KEY` /
`STRIPE_PUBLISHABLE_KEY`. `.env.example` adds placeholders for:

- `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`
- `STRIPE_WEBHOOK_SECRET` — from `stripe listen`
- `SESSION_SECRET` — dev default documented
- `DATABASE_PATH` — default `./data/app.db`
- `NEXT_PUBLIC_APP_URL` — default `http://localhost:3000`

## Testing

Vitest only; no Playwright (no browser-critical flows justify the harness;
revisit if e2e coverage is requested).

Unit (`tests/unit`):

- Stripe status → `SubscriptionStatus` mapping, incl. unknown → `unpaid`.
- Cookie sign/verify round-trip; tampered signature rejected.
- `isActive` boundary set.

Integration (`tests/integration`, real SQLite under `tests/.tmp`):

- Forged `checkout.session.completed` → subscription row `active`, user
  resolvable via `metadata.userId`.
- Replaying the same event id → no duplicate processing
  (`webhook_events` guard).
- `customer.subscription.deleted` → `status="canceled"`.
- Portal session request without `stripe_customer_id` →
  `NO_STRIPE_CUSTOMER`.

Stripe SDK is never hit in tests: events are constructed `Stripe.Event`
objects passed through `processBillingEvent`; checkout/portal creation is
covered by the real flow (`stripe listen` in dev).

## Scaffolding

- `mise.toml`: node 22, pnpm 9.
- `Makefile`: `setup dev build lint format typecheck check verify` +
  `db-generate db-migrate db-seed db-reset stripe-seed`.
  DB scripts run under `NODE_OPTIONS=--conditions=react-server`
  (server-only stub) as in the reference.
- `biome.json`, `tsconfig.json`, `drizzle.config.ts`, `vitest.config.ts`,
  `.editorconfig`, `.gitignore`, `.env.example`, `next.config.ts`.
- `AGENTS.md`: boundary rules + conventions above, trimmed from the
  reference (keeps the `next dev` agent-rules block).
- `README.md`: quickstart — `mise install && make setup`, `make db-reset`,
  `make stripe-seed`, `stripe listen --forward-to localhost:3000/api/v1/webhooks/stripe`,
  `make dev`.
- `DESIGN.md`: this document's architecture section, condensed.
- `docs/`: `architecture/overview.md`, `database/schema.md`,
  `operations/local-development.md`, `testing/strategy.md`.

## Dependencies

```
next react react-dom stripe drizzle-orm better-sqlite3 ulidx server-only
dev: typescript @types/node @types/react @types/react-dom
     @biomejs/biome drizzle-kit tsx vitest vite-tsconfig-paths
     @types/better-sqlite3
```

## Non-goals

- Gated content / lessons / any learning features.
- Production auth, team seats, invoices UI, dunning emails.
- Postgres migration (schema is portable; that's the extent of it).
- Playwright e2e (see Testing).
