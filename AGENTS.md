<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# AGENTS.md — Purpose Learning

Subscription-only app; modular monolith in one Next.js 16 deployable, SQLite
via Drizzle (Postgres-portable). Dev-only email auth — NOT production auth.

## Architecture boundaries

- Dependency direction: `app → features → server/modules → server/db`.
- Every `src/server/**` file starts with `import "server-only";`.
- Business rules live in `src/server/modules/billing`; route handlers and
  server actions delegate to it, but feature actions may use `server/db`
  directly for simple persistence.

## Conventions

- IDs: text ULIDs. Money: integer cents, `_cents` suffix. Timestamps:
  unixepoch ms, `_at` suffix.
- Errors: `BillingError(code)`; actions redirect to `?error=<code>`.
- Stripe truth: local `subscriptions` rows are a cache — webhooks
  (`checkout.session.completed`, `customer.subscription.*`) are the only
  writers. Never set subscription status in app code.
- Idempotent webhook processing via the `webhook_events` table; a row is
  recorded at terminal outcomes (applied or ignored), never before work.
- `current_period_end` is on `SubscriptionItem`, not `Subscription`.

## Commands

- Setup: `make setup`, `make db-reset`, `make stripe-seed`.
- Webhooks: `stripe listen --forward-to localhost:3000/api/v1/webhooks/stripe`
  → copy `whsec_` into `.env`.
- Gates: `make check` (lint+typecheck+tests), `make verify` (+ build).

## Database safety

- Migrations via `make db-generate` only; never hand-edit applied SQL.
- `foreign_keys=ON` + WAL in `db/client.ts`; no SQLite-isms in services.

## Security

- `.env.example` placeholders only; never commit `.env` or `data/*.db`.
- `SESSION_SECRET` dev default is insecure; override in `.env`.
- Session cookie is HMAC-signed `userId.sig`, httpOnly — demo-grade only.

## Testing

- Unit for pure rules (status mapping, cookie verify); integration on real
  SQLite under `tests/.tmp` for webhook/event flows. Stripe SDK is stubbed
  at the `processBillingEvent` boundary, never HTTP-mocked.
