# Design — Stripe Subscriptions + Finix

Condensed from `docs/superpowers/specs/2026-10-17-stripe-subscriptions-design.md`
and `docs/superpowers/specs/2026-10-17-finix-provider-design.md`.

## Goal

Minimal Next.js app selling learning-plan subscriptions: pick a plan on
`/pricing` → pay via Stripe Checkout *or* Finix card-on-file → webhook
activates the subscription → `/account/billing` shows status and provider
manage UI. Subscription slice only — no gated content, no learning features.

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
    subscribe/finix/page.tsx
    account/billing/page.tsx
    api/v1/webhooks/stripe/route.ts
    api/v1/webhooks/finix/route.ts
    api/v1/billing-tick/route.ts
  features/
    auth/actions.ts        — login(email), logout()
    billing/actions.ts     — subscribe, manageBilling, finixSubscribe, finixCancel
    billing/finix-form.tsx — Finix.js iframe card fields (client component)
  server/
    env.ts                 — process.env accessors, dev defaults
    db/client.ts           — better-sqlite3 + drizzle, WAL, foreign_keys=ON
    db/schema.ts           — users, plans, subscriptions, payment_instruments,
                             charges, webhook_events
    auth/session.ts        — cookie sign/verify, getCurrentUser()
    modules/billing/
      plans.ts             — plan queries
      subscriptions.ts     — upsert/status mapping/access check,
                             charge ledger helpers, applyChargeOutcome
      stripe.ts            — getStripe(), session + portal creation,
                             processBillingEvent(), handleStripeWebhook()
      finix.ts             — REST client, createFinixSubscription(),
                             chargeForPeriod(), processFinixEvent(),
                             handleFinixWebhook()
      tick.ts              — runBillingTick() renewal/retry/cancel driver
      webhookEvents.ts     — dedupe by (event_id, provider)
scripts/
  plans.ts, db-migrate.ts, db-seed.ts, stripe-seed.ts, finix-webhook-seed.ts
tests/
  unit/, integration/, helpers/, server-only.stub.ts
data/app.db                — gitignored
```

## Data model

IDs: text ULIDs. Money: integer cents (`_cents`). Timestamps: unixepoch ms
(`_at`). FKs explicit; WAL + `foreign_keys=ON`.

| table | columns |
|---|---|
| `users` | `id` PK, `email` unique, `stripe_customer_id` nullable, `finix_identity_id` nullable, `created_at` |
| `plans` | `id` PK, `slug` unique, `name`, `price_cents`, `currency`, `interval`, `stripe_price_id` nullable, `active`, `created_at` |
| `subscriptions` | `id` PK, `user_id` FK→users, `provider`, `stripe_subscription_id` unique nullable, `stripe_price_id` nullable, `finix_identity_id` nullable, `plan_id` FK→plans nullable (required on finix rows), `status`, `consecutive_failures`, `current_period_end` nullable, `cancel_at_period_end`, `created_at`, `updated_at` |
| `payment_instruments` | `id` PK, `user_id` FK→users unique (one card per user), `finix_instrument_id` unique (`PI_…`), `finix_identity_id`, `last4`/`brand` nullable, `created_at`, `updated_at` |
| `charges` | `id` PK (= transfer `idempotency_id`), `subscription_id` FK, `period_start`, `period_end`, `amount_cents`, `currency`, `status` (`pending`/`paid`/`failed`), `finix_transfer_id` nullable, `attempt_no`, `created_at`, `updated_at` |
| `webhook_events` | `id` PK, `event_id`, `provider`, `type`, `processed_at`; unique (event_id, provider) |

`subscriptions.stripe_subscription_id` unique gives idempotent upserts;
`webhook_events` records each event id at its terminal outcome (applied or
ignored), making replays no-ops. Errors leave no row, so retries re-process.

## Stripe flow

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

## Finix provider (second, optional)

Finix has no subscription product: it tokenizes a card into a
`payment_instrument` (`PI_…`) and our billing engine drives renewals.

| | Stripe | Finix |
|---|---|---|
| Checkout | Hosted Checkout Session | In-page Finix.js iframe → instrument |
| Renewals | Stripe-billed | `runBillingTick` posts scheduled Transfers |
| Manage/cancel | Customer Portal | `finixCancel` flags `cancel_at_period_end` |
| Truth via | `customer.subscription.*` webhooks | `transfer` events + response fast path |

Flow: `/pricing` "Pay with Finix" (shown only when `finixConfigured()`) →
`/subscribe/finix?plan=<id>` → `finix-form.tsx` loads
`https://js.finix.com/v/1/finix.js`, tokenizes to `PI_…` → `finixSubscribe`
(ensureIdentity → attachInstrument → payment_instruments upsert →
`subscriptions` `incomplete` row + first `charges` row → transfer).
`SUCCEEDED` settles immediately (`applyChargeOutcome` fast path); else the
webhook settles. `POST /api/v1/billing-tick` (header
`x-billing-secret: $SESSION_SECRET`, else 404) advances renewals at
`current_period_end`, retries while `past_due` (`consecutive_failures < 3`),
and deferred cancels. Subs with a pending charge are skipped. Failed first
charge → `incomplete_expired`; failed renewal → `past_due`; 3rd failure →
`canceled`. Periods are approximate: month = 30d, year = 365d.

Webhook: `POST /api/v1/webhooks/finix` verifies
`Finix-Signature: timestamp=…,sig=…` (HMAC-SHA256 of `${ts}:${body}`, 300s
freshness gate), dedupes transfer events via `webhook_events`, resolves the
charge via `tags.chargeId` (fallback: latest pending for the subscription),
and applies terminal outcomes. Finix status advances via `runBillingTick`,
the webhook, and the subscribe fast-path settlement.

## Errors

`BillingError` carries a machine code; actions redirect to `?error=<code>`.

| code | when |
|---|---|
| `UNAUTHENTICATED` | no valid session cookie |
| `PLAN_NOT_FOUND` | planId missing/inactive/no `stripe_price_id` |
| `STRIPE_NOT_CONFIGURED` | `STRIPE_SECRET_KEY` absent |
| `NO_STRIPE_CUSTOMER` | portal requested before any checkout |
| `FINIX_NOT_CONFIGURED` | any `FINIX_*` cred absent |
| `FINIX_INSTRUMENT_INVALID` | instrument rejected / not `PI_…` |
| `FINIX_NO_INSTRUMENT` | charge attempted with no saved instrument |
| `FINIX_SUB_EXISTS` | user already has a live finix subscription |
