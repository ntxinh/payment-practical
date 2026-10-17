# Local development

## Setup

    mise install          # node 22 + pnpm 9
    make setup            # pnpm install + next typegen
    cp .env.example .env  # fill in keys
    make db-reset         # migrate + seed plans
    make stripe-seed      # create Stripe products/prices, link plans
    make dev              # http://localhost:3000

## Environment variables

| var | required | default / source |
|---|---|---|
| `STRIPE_SECRET_KEY` | yes (checkout/webhook) | your `sk_test_...` |
| `STRIPE_PUBLISHABLE_KEY` | optional | `pk_test_...` |
| `STRIPE_WEBHOOK_SECRET` | webhook route only | from `stripe listen` output |
| `SESSION_SECRET` | no | insecure dev default; set in `.env` |
| `DATABASE_URL` | no | `file:./data/app.db` |
| `NEXT_PUBLIC_APP_URL` | no | `http://localhost:3000` |

## Webhooks

    stripe listen --forward-to localhost:3000/api/v1/webhooks/stripe

Copy the printed `whsec_...` into `.env` as `STRIPE_WEBHOOK_SECRET`. Without
it the route 404s (so an unconfigured deploy never acks events it can't
verify).

Manually fire an event to test the pipeline end-to-end:

    stripe trigger checkout.session.completed

(Synthetic triggers carry no `metadata.userId`, so they exercise the IGNORED
path. For a full apply, run a real checkout with test card
`4242 4242 4242 4242`.)

## Resetting the database

    make db-reset   # deletes data/*.db*, re-migrates, re-seeds plans

Re-run `make stripe-seed` afterwards to relink `stripe_price_id` values —
seeded products/prices are looked up by metadata slug, so it's idempotent.

## Useful commands

`make check` — lint + typecheck + tests. `make verify` — + `next build`.
`make format` — biome --write. `make db-generate` — new migration from
schema diff.
