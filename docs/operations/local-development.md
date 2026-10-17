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
| `FINIX_USERNAME` / `FINIX_PASSWORD` | finix only | sandbox API creds |
| `FINIX_MERCHANT_ID` / `FINIX_APPLICATION_ID` | finix only | `MU_…` / `AP_…` |
| `FINIX_BASE_URL` | no | sandbox API base |
| `FINIX_WEBHOOK_SECRET` | finix webhook route | from `make finix-webhook-seed` |

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

## Finix

With `FINIX_*` creds set, `/pricing` gains a **Pay with Finix** link →
`/subscribe/finix?plan=<id>`: Finix.js iframe fields tokenize the card into
a `PI_…` payment instrument (card data never touches the app). The first
charge is a Transfer; `SUCCEEDED` settles immediately (response fast path),
otherwise the webhook settles it.

Register the webhook once (Finix-side resource, prints the secret):

    make finix-webhook-seed   # → set FINIX_WEBHOOK_SECRET in .env

Finix can't deliver to localhost — point the webhook URL at a tunnel, or
rely on the response fast path for the demo. Without
`FINIX_WEBHOOK_SECRET` + creds the route 404s.

There is no subscription product at Finix — the app bills renewals itself.
Drive the tick manually (dev cron stand-in; 404 without the header):

    curl -X POST -H "x-billing-secret: $SESSION_SECRET" localhost:3000/api/v1/billing-tick
    # → {"data":{"renewed":n,"retried":n,"canceled":n,"skipped":n}}

The tick renews active subs at `current_period_end`, retries `past_due`
(`consecutive_failures < 3`), applies `cancel_at_period_end`, and cancels
after 3 failures. Subs with a pending charge are skipped.

## Resetting the database

    make db-reset   # deletes data/*.db*, re-migrates, re-seeds plans

Re-run `make stripe-seed` afterwards to relink `stripe_price_id` values —
seeded products/prices are looked up by metadata slug, so it's idempotent.

## Useful commands

`make check` — lint + typecheck + tests. `make verify` — + `next build`.
`make format` — biome --write. `make db-generate` — new migration from
schema diff.
