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
| `stripe_subscription_id` | text | unique — idempotent upsert key |
| `stripe_price_id` | text | price subscribed to |
| `status` | text | Stripe `SubscriptionStatus` |
| `current_period_end` | int | nullable; read from `SubscriptionItem` |
| `cancel_at_period_end` | int | boolean 0/1 |
| `created_at`, `updated_at` | int | unixepoch ms |

## webhook_events

| column | type | notes |
|---|---|---|
| `stripe_event_id` | text | PK — dedupe key |
| `type` | text | event type |
| `processed_at` | int | unixepoch ms |

## Idempotency rationale

Two cheap guarantees cover at-least-once Stripe delivery:

- **Webhook dedupe**: `processBillingEvent` checks `webhook_events` for the
  incoming `stripe_event_id`; a hit short-circuits to `IGNORED`. The row is
  written only at a terminal outcome — after a successful upsert or when the
  event is determined ignorable — never before work. So a crashed/failed
  processing leaves no row, the route 5xxs, and Stripe's retry re-processes;
  a duplicated delivery is a no-op.
- **Upsert key**: `subscriptions.stripe_subscription_id` is unique, so
  `checkout.session.completed` and later `customer.subscription.*` events
  for the same subscription converge on one row.
