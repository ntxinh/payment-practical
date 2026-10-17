# Architecture overview

Modular monolith in one Next.js 16 deployable. Dependency direction:

```
app → features → server/modules → server/db
```

- `src/app/` — App Router pages + the webhook route handler.
- `src/features/` — server actions (`auth`, `billing`): parse form data →
  authorize → delegate → serialize/redirect.
- `src/server/modules/` — business rules. `billing/` holds plan queries,
  subscription mapping, Stripe session/portal creation, the Finix REST
  client + charge ledger, the billing tick, and webhook event processing.
- `src/server/db/` — drizzle client + schema only.

Every `src/server/**` file starts with `import "server-only";`, so nothing
server-side can be bundled into a client component. Modules expose service
functions and own the business rules; `server/db` (client + schema) may also
be used directly by feature actions for simple persistence (e.g. user
find-or-create) and by app pages/route handlers for reads.

## File map

```
src/app/login/page.tsx              dev email login
src/app/pricing/page.tsx            plan picker → subscribe / Pay with Finix
src/app/subscribe/finix/page.tsx    Finix.js card iframe → finixSubscribe
src/app/account/billing/page.tsx    status + portal (stripe) / cancel-at-period-end (finix)
src/app/api/v1/webhooks/stripe/route.ts  POST → handleStripeWebhook
src/app/api/v1/webhooks/finix/route.ts   POST → handleFinixWebhook
src/app/api/v1/billing-tick/route.ts     POST → runBillingTick (x-billing-secret gated)
src/features/auth/actions.ts        login(email), logout()
src/features/billing/actions.ts     subscribe, manageBilling, finixSubscribe, finixCancel
src/features/billing/finix-form.tsx Finix.js v1 iframe card fields (client)
src/server/env.ts                   env accessors w/ dev defaults
src/server/db/client.ts             better-sqlite3 + drizzle (WAL, FKs on)
src/server/db/schema.ts             users, plans, subscriptions, payment_instruments,
                                    charges, webhook_events
src/server/auth/session.ts          HMAC cookie sign/verify, getCurrentUser()
src/server/modules/billing/         plans, subscriptions, stripe, finix, tick,
                                    webhookEvents, errors
scripts/plans.ts db-migrate.ts db-seed.ts stripe-seed.ts finix-webhook-seed.ts
```

## Why webhooks are the sole writer

Stripe owns subscription state. A user can cancel or change plans in the
Customer Portal without our checkout ever running, so writing status from a
redirect back (e.g. `success_url`) would silently drift. Instead the app
writes nothing on checkout completion — it only redirects to Stripe — and
three webhook events (`checkout.session.completed`,
`customer.subscription.updated`, `customer.subscription.deleted`) upsert the
local `subscriptions` row. Local rows are a read cache; Stripe is truth.

The webhook route verifies the signature, then `processBillingEvent` dedupes
by `event_id` (provider `stripe`) and records each event in `webhook_events`
at its terminal outcome (applied or ignored). Unrecorded errors surface as
5xx so Stripe retries and re-processes.

## Finix asymmetry

Finix has no subscription product, so the provider's lifecycle is inverted:
the app owns billing. `/subscribe/finix` renders Finix.js iframe fields that
tokenize the card into a `payment_instrument` (`PI_…` — card data never
touches this app); `finixSubscribe` creates an `incomplete` subscription +
first `charges` row and posts a Transfer. `SUCCEEDED` settles immediately;
otherwise the `transfer` webhook event (deduped on provider `finix`) settles
it. `runBillingTick` — driven by `POST /api/v1/billing-tick`, a dev-gated
cron stand-in — is the only path that renews, retries, and applies
`cancel_at_period_end`. `payment_instruments.user_id` is unique (one card
per user; re-adding replaces).
