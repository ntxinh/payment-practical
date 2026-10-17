# Purpose Learning

Stripe subscription slice: plan picker → Checkout → webhook → local status → Customer Portal.

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

## Commands

`make check` — lint + typecheck + tests. `make verify` — + build.
See `docs/operations/local-development.md` for details.
