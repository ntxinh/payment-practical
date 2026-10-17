# Testing strategy

Vitest only; no Playwright. No browser-critical flows justify an e2e harness
— checkout and portal live on Stripe's pages, so our e2e surface would be a
form POST and a redirect. Revisit if gated content lands.

## Unit vs integration

- **Unit** (`tests/unit`): pure rules, no DB or Stripe — Stripe status →
  `SubscriptionStatus` mapping (incl. unknown → `unpaid`), `isActive`
  boundary set, session-cookie sign/verify round-trip and tamper rejection.
- **Integration** (`tests/integration`): real SQLite via better-sqlite3 —
  schema/FK behavior, webhook route responses (404/400/200), and
  `processBillingEvent` flows: forged `checkout.session.completed` →
  `active` row, replayed event id → no-op via `webhook_events`,
  `customer.subscription.deleted` → `canceled`, portal without
  `stripe_customer_id` → `NO_STRIPE_CUSTOMER`.

## `tests/.tmp` isolation

`tests/helpers/db.ts` creates a fresh `tests/.tmp/<name>-<ts>-<rand>.db` per
test, applies the drizzle migrations to it, and returns a `DB` handle.
Nothing shares state; `tests/.tmp` is gitignored. This exercises the real
schema and `foreign_keys` behavior instead of a mock.

## Stripe boundary

The Stripe SDK is never HTTP-mocked. Two seams instead:

- **`setStripeForTests(stub)`** in `modules/billing/stripe.ts` injects a
  stub `Stripe` client (or `null` to force `STRIPE_NOT_CONFIGURED`,
  `undefined` to reset the lazy singleton) so module-level code runs with
  `process.env` keys set after module load.
- **`processBillingEvent(db, stripe, event)`** takes a constructed
  `Stripe.Event` directly — tests forge `checkout.session.completed` /
  `customer.subscription.*` objects and assert DB effects.

For the webhook route itself, tests build a real signed header with
`stripe.webhooks.generateTestHeaderString({ payload, secret })` and a test
`whsec`, so `constructEvent` verification runs for real — only the network
is absent.

Checkout/portal session *creation* is covered by the real dev flow
(`stripe listen` + test card), not unit tests.

## Run

    make test              # unit + integration
    pnpm vitest run tests/unit
    pnpm vitest run tests/integration
