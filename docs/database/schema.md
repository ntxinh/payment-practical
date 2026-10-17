# Database schema

SQLite via better-sqlite3 + drizzle-orm; portable to Postgres. Conventions:
text ULID IDs, integer cents (`_cents`), unixepoch-ms timestamps (`_at`),
explicit FKs, WAL + `foreign_keys=ON` in `src/server/db/client.ts`.
Migrations: `make db-generate` (drizzle-kit) — never hand-edit applied SQL.

## users

| column | type | notes |
|---|---|---|
| `id` | text | PK, ULID |
| `email` | text | unique, not null — login key |
| `stripe_customer_id` | text | nullable; set on first checkout |
| `finix_identity_id` | text | nullable; Finix `ID_…` Identity |
| `created_at` | int | unixepoch ms |

## plans

| column | type | notes |
|---|---|---|
| `id` | text | PK, ULID |
| `slug` | text | unique (`starter`, `pro`) |
| `name` | text | display name |
| `price_cents` | int | USD cents |
| `currency` | text | e.g. `usd` |
| `interval` | text | `"month"` / `"year"` |
| `stripe_price_id` | text | nullable until `make stripe-seed` links it |
| `active` | int | boolean 0/1 |
| `created_at` | int | unixepoch ms |

## subscriptions

| column | type | notes |
|---|---|---|
| `id` | text | PK, ULID |
| `user_id` | text | FK → `users.id` |
| `provider` | text | `"stripe"` (default) / `"finix"` |
| `stripe_subscription_id` | text | unique, nullable — idempotent upsert key; null on finix rows |
| `stripe_price_id` | text | nullable; price subscribed to (stripe) |
| `finix_identity_id` | text | nullable; set on finix rows |
| `plan_id` | text | FK → `plans.id`, nullable; required on finix rows (tick needs price+interval) |
| `status` | text | Stripe `SubscriptionStatus` vocabulary |
| `consecutive_failures` | int | finix dunning counter; `>= 3` → tick cancels |
| `current_period_end` | int | nullable; read from `SubscriptionItem` (stripe) or charge ledger (finix) |
| `cancel_at_period_end` | int | boolean 0/1 |
| `created_at`, `updated_at` | int | unixepoch ms |

## payment_instruments

Finix card-on-file. One card per user: `user_id` unique — re-adding a card
replaces the row (the orphaned Finix PI is accepted sandbox behavior).

| column | type | notes |
|---|---|---|
| `id` | text | PK, ULID |
| `user_id` | text | FK → `users.id`, unique |
| `finix_instrument_id` | text | unique, `PI_…` |
| `finix_identity_id` | text | owning Finix Identity |
| `last4`, `brand` | text | nullable, display only |
| `created_at`, `updated_at` | int | unixepoch ms |

## charges

Per-payment ledger for finix self-billing. `id` doubles as the Finix
Transfer `idempotency_id` — safe for tick/webhook retries.

| column | type | notes |
|---|---|---|
| `id` | text | PK, ULID |
| `subscription_id` | text | FK → `subscriptions.id` |
| `period_start`, `period_end` | int | billed period, unixepoch ms |
| `amount_cents` | int | charge amount |
| `currency` | text | e.g. `USD` |
| `status` | text | `pending` / `paid` / `failed` |
| `finix_transfer_id` | text | nullable; `TR_…` once issued |
| `attempt_no` | int | 1 for renewals, increments on retries |
| `created_at`, `updated_at` | int | unixepoch ms |

## webhook_events

| column | type | notes |
|---|---|---|
| `id` | text | PK, ULID |
| `event_id` | text | provider event key (stripe `evt_…` / finix event or transfer key) |
| `provider` | text | `"stripe"` (default) / `"finix"` |
| `type` | text | event type |
| `processed_at` | int | unixepoch ms |

Unique index on (`event_id`, `provider`).

## Idempotency rationale

Two cheap guarantees cover at-least-once delivery:

- **Webhook dedupe**: event processors check `webhook_events` for the
  incoming `event_id` + `provider`; a hit short-circuits to `IGNORED`. The
  row is written only at a terminal outcome — after a successful apply or
  when the event is determined ignorable — never before work. So a
  crashed/failed processing leaves no row, the route 5xxs, and the
  provider's retry re-processes; a duplicated delivery is a no-op.
- **Upsert key**: `subscriptions.stripe_subscription_id` is unique, so
  `checkout.session.completed` and later `customer.subscription.*` events
  for the same subscription converge on one row. For finix, `charges.id` is
  the Transfer `idempotency_id`, so a retried tick or replayed webhook can
  never double-charge.
