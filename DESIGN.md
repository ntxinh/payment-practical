# Design — Stripe Subscriptions

Condensed from `docs/superpowers/specs/2026-10-17-stripe-subscriptions-design.md`.

## Goal

Minimal Next.js app selling learning-plan subscriptions via Stripe: pick a
plan on `/pricing` → Stripe Checkout → webhook activates the subscription →
`/account/billing` shows status and offers a Customer Portal redirect.
Subscription slice only — no gated content, no learning features.

## Architecture

Modular monolith; dependency direction `app → features → server/modules →
server/db`. Every `src/server/**` file starts with `import "server-only";`.
Route handlers and server actions delegate to `src/server/modules/billing/`
for business rules; feature actions may use `server/db` directly for simple
persistence (e.g. user find-or-create in `features/auth/actions.ts`).

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
    billing/actions.ts     — subscribe(formData), manageBilling()
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
  plans.ts, db-migrate.ts, db-seed.ts, stripe-seed.ts
tests/
  unit/, integration/, helpers/, server-only.stub.ts
data/app.db                — gitignored
```

## Data model

IDs: text ULIDs. Money: integer cents (`_cents`). Timestamps: unixepoch ms
(`_at`). FKs explicit; WAL + `foreign_keys=ON`.

| table | columns |
|---|---|
| `users` | `id` PK, `email` unique, `stripe_customer_id` nullable, `created_at` |
| `plans` | `id` PK, `slug` unique, `name`, `price_cents`, `currency`, `interval`, `stripe_price_id` nullable, `active`, `created_at` |
| `subscriptions` | `id` PK, `user_id` FK→users, `stripe_subscription_id` unique, `stripe_price_id`, `status`, `current_period_end` nullable, `cancel_at_period_end`, `created_at`, `updated_at` |
| `webhook_events` | `stripe_event_id` PK, `type`, `processed_at` |

`subscriptions.stripe_subscription_id` unique gives idempotent upserts;
`webhook_events` records each event id at its terminal outcome (applied or
ignored), making replays no-ops. Errors leave no row, so Stripe retries
re-process.

## Flow

```mermaid
sequenceDiagram
  actor U as User
  participant App as Next app
  participant S as Stripe
  U->>App: POST /login (email)
  App->>U: Set-Cookie session=uid.hmac
  U->>App: /pricing → subscribe(planId)
  App->>S: customers get-or-create; checkout.sessions.create(mode=subscription)
  S-->>U: 303 → Checkout
  S->>App: POST /api/v1/webhooks/stripe (checkout.session.completed)
  App->>App: verify signature → webhook_events dedupe → upsert subscription
  S->>App: customer.subscription.updated / .deleted
  App->>App: map Stripe status → subscriptions row
  U->>App: manageBilling()
  App->>S: billingPortal.sessions.create → 303
```

Webhooks are the only writers of `subscriptions` — local rows are a cache of
Stripe truth. `checkout.session.completed`, `customer.subscription.updated`
and `.deleted` are handled; everything else is ignored but acked 200.

## Errors

`BillingError` carries a machine code; actions redirect to `?error=<code>`.

| code | when |
|---|---|
| `UNAUTHENTICATED` | no valid session cookie |
| `PLAN_NOT_FOUND` | planId missing/inactive/no `stripe_price_id` |
| `STRIPE_NOT_CONFIGURED` | `STRIPE_SECRET_KEY` absent |
| `NO_STRIPE_CUSTOMER` | portal requested before any checkout |
