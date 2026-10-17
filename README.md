# Purpose Learning

Stripe subscription slice: plan picker → Checkout → webhook → local status → Customer Portal.
Optional second provider: Finix (card iframe → instrument → self-billing tick).

## Quickstart

    mise install
    make setup
    cp .env.example .env        # add your sk_test_ key
    make db-reset               # migrate + seed plans
    make stripe-seed            # create Stripe products/prices, link plans
    stripe listen --forward-to localhost:3000/api/v1/webhooks/stripe
    # paste the printed whsec_ into .env as STRIPE_WEBHOOK_SECRET
    make dev                    # http://localhost:3000

Login with any email (dev auth). Subscribe with Stripe test card `4242 4242 4242 4242`.

## Finix (optional second provider)

With `FINIX_*` creds in `.env` (sandbox), `/pricing` shows **Pay with Finix**:
card entry in Finix.js iframe fields → payment instrument on file → our
billing engine charges renewals. Register the webhook once:

    make finix-webhook-seed        # prints a secret → FINIX_WEBHOOK_SECRET in .env

Finix can't reach localhost — use a tunnel, or rely on the transfer-response
fast path. Advance renewals/cancellations/retries manually:

    curl -X POST -H "x-billing-secret: $SESSION_SECRET" localhost:3000/api/v1/billing-tick

## Commands

`make check` — lint + typecheck + tests. `make verify` — + build.
See `docs/operations/local-development.md` for details.
