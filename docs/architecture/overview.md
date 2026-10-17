# Architecture overview

Modular monolith in one Next.js 16 deployable. Dependency direction:

```
app → features → server/modules → server/db
```

- `src/app/` — App Router pages + the webhook route handler.
- `src/features/` — server actions (`auth`, `billing`): parse form data →
  authorize → delegate → serialize/redirect.
- `src/server/modules/` — business rules. `billing/` holds plan queries,
  subscription mapping, Stripe session/portal creation, and webhook event
  processing.
- `src/server/db/` — drizzle client + schema only.

Every `src/server/**` file starts with `import "server-only";`, so nothing
server-side can be bundled into a client component. Modules expose service
functions; schema internals are never imported outside `server/db` except by
sibling server modules.

## File map

```
src/app/login/page.tsx              dev email login
src/app/pricing/page.tsx            plan picker → createCheckoutSession
src/app/account/billing/page.tsx    status + createPortalSession
src/app/api/v1/webhooks/stripe/route.ts  POST → handleStripeWebhook
src/features/auth/actions.ts        login(email), logout()
src/features/billing/actions.ts     createCheckoutSession, createPortalSession
src/server/env.ts                   env accessors w/ dev defaults
src/server/db/client.ts             better-sqlite3 + drizzle (WAL, FKs on)
src/server/db/schema.ts             users, plans, subscriptions, webhook_events
src/server/auth/session.ts          HMAC cookie sign/verify, getCurrentUser()
src/server/modules/billing/         plans, subscriptions, stripe, errors
scripts/db-migrate.ts db-seed.ts stripe-seed.ts
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
by `stripe_event_id` and records each event in `webhook_events` at its
terminal outcome (applied or ignored). Unrecorded errors surface as 5xx so
Stripe retries and re-processes.
