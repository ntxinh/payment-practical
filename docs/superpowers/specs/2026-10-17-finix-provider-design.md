# Finix Payment Provider — Purpose Learning

Date: 2026-10-17
Status: Approved approach (provider-symmetric module + charges ledger); pre-implementation

## Goal

Add Finix as a second, user-selectable payment provider alongside Stripe:

- `/pricing` offers "Pay with Stripe" / "Pay with Finix" per plan.
- Finix card entry happens in Finix.js iframe fields (tokenization) — card
  data never touches our server.
- The card becomes a Finix `payment_instrument` saved on file; renewals are
  charged by OUR billing engine (Finix has no subscription product).
- Local `subscriptions` rows stay provider-agnostic truth; a new `charges`
  table is the per-payment ledger.

Provider choice made in brainstorming: **card-on-file renewals**, **provider
toggle on /pricing**, **tokenization iframe** (not hosted forms).

## Provider asymmetry (drives the whole design)

| | Stripe | Finix |
|---|---|---|
| Checkout | Hosted Checkout Session | In-page Finix.js tokenize → instrument |
| Renewals | Stripe-billed | We bill: scheduled Transfer on the saved instrument |
| Manage/cancel | Customer Portal | Self-serve: "cancel at period end" flag |
| Truth arrives via | checkout.session.completed + customer.subscription.* | transfer entity events (webhook) + charge response fast-path |

## Schema changes (one drizzle migration)

`users`: + `finix_identity_id` text (Finix `ID_…` Identity, reused across
subscriptions).

`plans`: unchanged. Finix plain `/transfers` need no Product — Products
and `SUS_` subscriptions belong to Finix's native Subscriptions API,
which our self-billing engine does not use. No finix-seed, no
`finix_product_id`, no `finix_subscription_id`.

`subscriptions`: + `provider` text not null default `'stripe'`;
+ `finix_identity_id` text nullable; + `plan_id` text FK→plans nullable
(required for finix rows — tick needs price+interval; stripe rows may stay
null, they look up by `stripe_price_id`);
+ `consecutive_failures` int not null default 0.

`payment_instruments` (new): `id` text PK, `user_id` text FK→users UNIQUE
(one card per user — dev scope), `finix_instrument_id` text unique
(`PI_…`), `finix_identity_id`, `last4`/`brand` text nullable,
`created_at`/`updated_at` int. Re-adding a card replaces the row
(`onConflictDoUpdate` on user_id); the orphaned PI at Finix is accepted
sandbox behavior — documented, not cleaned up.

`charges` (new): `id` text PK (ULID — doubles as the Transfer
`idempotency_id`), `subscription_id` text FK→subscriptions, `period_start`/
`period_end` int, `amount_cents` int, `currency` text, `status` text
(`'pending'|'paid'|'failed'`), `finix_transfer_id` text nullable,
`attempt_no` int not null default 1, `created_at`/`updated_at` int.

`webhook_events`: rename `stripe_event_id` → `event_id`; + `provider` text
not null default `'stripe'`. Stripe dedupe code updated to write
provider `'stripe'`. (Clean cutover — one migration renames + adds.)

## Finix module — `src/server/modules/billing/finix.ts`

Thin REST client, mirrors `stripe.ts` shape:

```ts
type Finix = { fetchFn: typeof fetch; base: string; auth: string; merchantId: string; applicationId: string };
getFinix(): Finix            // throws BillingError("FINIX_NOT_CONFIGURED")
setFinixForTests(stub)
finixRequest(finix, method, path, body?): Promise<any>  // Basic auth, Finix-Version: 2022-02-01, 15s AbortController timeout
verifyFinixSignature(payload, "timestamp=…,sig=…", secret): boolean  // HMAC-SHA256(`${ts}:${payload}`), timingSafeEqual — copy from reference
transferOutcome(state): "paid" | "failed" | "pending"   // SUCCEEDED→paid; FAILED/CANCELED→failed; else pending
ensureIdentity(db, finix, user): Promise<string>        // users.finix_identity_id get-or-create (identity POST type/entity fields verified against Finix docs at implementation)
attachInstrument(finix, identityId, instrumentId)       // POST /payment_instruments/{id} {type:'PAYMENT_CARD', identity}
chargeForPeriod(db, finix, sub, plan, charge): Promise<void>  // POST /transfers {amount, currency, source: PI id, merchant_id, idempotency_id: charge.id, tags:{chargeId, subscriptionId}}
processFinixEvent(db, event): "APPLIED" | "IGNORED"     // transfer entity events only; dedupe provider 'finix', record at terminal (same ruling as stripe)
handleFinixWebhook(db, payload, signatureHeader): {status}  // 404 no FINIX_WEBHOOK_SECRET/creds; 400 bad sig; 200 else
```

Shared outcome helper — `applyChargeOutcome(db, charge, outcome)` lives in
`modules/billing/subscriptions.ts` (charge/period/failure transitions;
consumed by the `finix.ts` fast-path + webhook AND `tick.ts`). Feature
actions `finixSubscribe(formData)`/`finixCancel()` live in
`src/features/billing/actions.ts` beside `subscribe`/`manageBilling`.

## Flows

### Subscribe (Finix)

1. `/pricing` plan card: two forms — "Pay with Stripe" (existing
   `subscribe`), "Pay with Finix" → GET `/subscribe/finix?plan=<slug>`.
2. `/subscribe/finix` page: server-rendered shell passes `applicationId` +
   `planId` to a client component (`finix-form.tsx`) that loads
   `https://js.finix.com/v1/finix.js` via `next/script`, mounts iframe card
   fields, calls its tokenize API, then submits the returned
   `payment_instrument` id through a hidden input to `finixSubscribe`.
3. `finixSubscribe(formData)` — auth-required:
   `ensureIdentity` → `attachInstrument` (validates the PI belongs to the
   identity; Finix rejects otherwise → `FINIX_INSTRUMENT_INVALID`) → upsert
   `payment_instruments` row → create `subscriptions` row
   `{provider:'finix', status:'incomplete', plan_id, currentPeriodEnd:
   now+period(plan)}` → create `charges` period-1 row →
   `chargeForPeriod`. If the Transfer response is already `SUCCEEDED`,
   settle immediately (same `applyChargeOutcome` the webhook uses — fast
   path); else status stays `incomplete` until the webhook. Redirect
   `/account/billing?pending=1` or `?success=1`.
4. Webhook `transfer` event with `tags.chargeId` (fallback: latest pending
   charge for `tags.subscriptionId`): charge → paid/failed; on paid →
   subscription `active`, `consecutive_failures=0`; on failed first charge
   → `incomplete_expired`.

### Renewal tick — `runBillingTick(db)` in `modules/billing/tick.ts`

Endpoint `POST /api/v1/billing-tick`, gated by header
`x-billing-secret: $SESSION_SECRET` (else 404). Dev/demo stand-in for cron —
documented as such.

- `provider='finix'` AND `status ∈ {active}` AND `current_period_end <= now`:
  - `cancel_at_period_end` → `status='canceled'`.
  - else insert charge (period `[end, end+Δ]`, `attempt_no=1`) +
    `chargeForPeriod`.
- `status='past_due'` AND `consecutive_failures < MAX_FAILURES (=3)`:
  insert another charge (`attempt_no+1`) + charge.
- `consecutive_failures >= 3` → `status='canceled'`.
- Charge outcome application (shared with webhook — decided by
  `subscription.status`, NOT `attempt_no` which resets per renewal):
  paid → `current_period_end = charge.period_end`, status `active`,
  failures reset; failed → `consecutive_failures++` and
  status `incomplete_expired` when sub was `incomplete`, else `past_due`.
- Tick skips any finix sub with a pending charge (in-flight transfer).

Period Δ: `interval 'month' → 30d`, `'year' → 365d` (ms). Documented
approximation — dev billing engine, not calendar billing.

### Cancel (Finix)

`/account/billing` detects `sub.provider`: stripe → existing portal form;
finix → "Cancel at period end" form → `finixCancel` action → sets
`cancel_at_period_end`. Tick cancels at `current_period_end`. No refunds.

### Webhook route

`POST /api/v1/webhooks/finix` — `req.text()`, `Finix-Signature` header →
`handleFinixWebhook`. Same semantics as the Stripe route (record at
terminal, throws → 500 → Finix retries — Finix retries failed deliveries
like Stripe does).

### Webhook registration

`scripts/finix-webhook-seed.ts` — `POST /webhooks {url, enabled:true}` on
the Finix API, prints the returned secret and instructs adding
`FINIX_WEBHOOK_SECRET` to `.env`. One-time manual step (mirrors
`stripe listen` for Stripe). Local dev: no delivery to localhost — point it
at a tunnel or rely on the charge-response fast path + tick for demo flow.
Documented, not automated.


## UI changes

- `/pricing`: plan card shows both provider buttons; Finix button links to
  `/subscribe/finix?plan=<slug>` (hidden with a "Finix not configured" note
  when FINIX creds are absent).
- `/subscribe/finix`: card iframe + submit. Only client component in the
  app — Finix.js init params (`application`/`AP_…` id, `environment:
  'sandbox'` or equivalent) verified against Finix docs at implementation;
  the only contract is card fields in → `PI_…` id out.
- `/account/billing`: provider-aware manage section (portal vs cancel
  button), shows `provider` and `current_period_end` for finix subs,
  `?pending=1` "payment processing" state.

## Types & errors

New `BillingErrorCode`s: `FINIX_NOT_CONFIGURED`, `FINIX_INSTRUMENT_INVALID`,
`FINIX_NO_INSTRUMENT`. `ChargeStatus` union as
above. `SubscriptionStatus` union unchanged (`paused`/`trialing` unused by
finix but tolerated); `isActive` unchanged — incomplete_expired finix subs
grant no access.

## Env

Existing `.env` has all FINIX_* creds. `.env.example` additions:
`FINIX_WEBHOOK_SECRET=` (from finix-webhook-seed), `BILLING_TICK_SECRET`
default = SESSION_SECRET reuse (documented — no new secret needed; the tick
route reads `x-billing-secret` against `sessionSecret()`).

## Testing

Unit: `transferOutcome` mapping, `verifyFinixSignature` (forge + tamper +
malformed), period Δ math.

Integration (real sqlite, `fetchFn` stubbed via `setFinixForTests`):

- `createFinixSubscription` happy path → identity reused, instrument row,
  sub `incomplete` → settle → `active` (both response fast-path and
  webhook path).
- Renewal tick: active sub at period end → new charge + transfer issued;
  failed renewal → `past_due` + failures++; 3rd failure → `canceled`;
  `cancel_at_period_end` sub → `canceled` at period end.
- Webhook route: forged `Finix-Signature` → 200/settle; bad sig → 400;
  no secret → 404.
- Stripe paths unchanged — existing tests must stay green (regression).

`finix-form.tsx`: no test — thin Finix.js passthrough (browser lib).
Demo note: sandbox Finix accounts auto-approve most transfers.

## Docs to update

README (finix quickstart: `make finix-webhook-seed`, tick endpoint, card flow),
AGENTS.md (provider asymmetry + tick rule: only `runBillingTick`/webhooks
advance finix status), DESIGN.md, docs/architecture|database|operations|
testing.

## Non-goals

- Dunning emails, refunds, proration, multiple cards per user,
  calendar-precise periods, hosted Finix checkout forms, Finix payout/
  merchant management, production cron infra (tick is dev-gated).
- Stripe flow changes beyond the `provider` column + shared dedupe table.
