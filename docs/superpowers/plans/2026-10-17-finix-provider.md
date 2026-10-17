# Finix Payment Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Finix as a second, user-selectable payment provider — Finix.js tokenization → saved payment instrument → self-billed renewals via a dev billing tick + transfer webhooks.

**Architecture:** `finix.ts` mirrors `stripe.ts` (lazy singleton, `setXForTests`, `handleXWebhook`). New `charges` ledger + `runBillingTick()` own Finix renewal lifecycle; `subscriptions` stays provider-agnostic truth. `webhook_events` generalizes to per-provider `event_id`.

**Tech Stack:** same as existing app — Next.js 16, stripe@23 (untouched paths), drizzle + better-sqlite3, Finix REST (fetch + Basic auth, `Finix-Version: 2022-02-01`), Finix.js iframe via `next/script`, vitest.

**Spec:** `docs/superpowers/specs/2026-10-17-finix-provider-design.md` (amended: NO Finix products/`SUS_`/finix-seed — plain transfers only)

## Global Constraints

- Every `src/server/**` file: `import "server-only";` line 1. features files: `"use server"`.
- Money `_cents` int; timestamps unixepoch **ms** `_at`; IDs ULIDs. `attempt_no`/`consecutive_failures` ints.
- Finix `transfer.state`: `SUCCEEDED`→paid, `FAILED`/`CANCELED`→failed, else pending.
- Charge outcome is decided by **subscription.status**, not `attempt_no` (resets per renewal): failed → `incomplete_expired` only when sub was `incomplete`; else `past_due`.
- `webhook_events`: record at terminal outcomes only (errors → 500 → provider retry); dedupe SELECT-first; per-provider `event_id` unique (Finix event keys are synthesized, see Task 4).
- Finix REST: `Authorization: Basic base64(USERNAME:PASSWORD)`; `Finix-Version: 2022-02-01`; 15s AbortController timeout; `merchant_id` from env on every transfer; `currency` uppercased.
- `charge.id` (ULID) doubles as the Transfer `idempotency_id` and `tags.chargeId`.
- `runBillingTick` NEVER touches stripe subs. Only tick/webhooks advance finix status.
- Tick route gated `x-billing-secret` vs `sessionSecret()`; wrong/missing → 404.
- One instrument per user (`payment_instruments.user_id` UNIQUE, replace on conflict). Orphaned PI at Finix: accepted, documented.
- Finix.js page contract: card iframe in → `PI_…` instrument id out via hidden `paymentInstrumentId` input. Exact init params verified against Finix docs at implementation time (spec-sanctioned).
- `.env` never committed; FINIX_* names: `FINIX_USERNAME`, `FINIX_PASSWORD`, `FINIX_MERCHANT_ID`, `FINIX_APPLICATION_ID`, `FINIX_BASE_URL`, `FINIX_WEBHOOK_SECRET`.

---

### Task 1: Schema migration — provider columns + charges + instruments + generalized webhook_events

**Files:**
- Modify: `src/server/db/schema.ts` — add columns/tables, rename `stripe_event_id`→`event_id`
- Modify: `src/server/modules/billing/stripe.ts` — dedupe helpers use `eventId`/`provider`
- Create: `src/server/modules/billing/webhookEvents.ts` — shared dedupe helpers
- Test: `tests/integration/schema.test.ts` (new)

**Interfaces:**
- Produces:
  - `paymentInstruments`, `charges` tables; `type PaymentInstrument`, `type Charge`
  - `users.finixIdentityId`, `plans` unchanged, `subscriptions.{provider, finixIdentityId, planId, consecutiveFailures}`
  - `webhookEvents.{eventId, provider, type, processedAt}`
  - `seenEvent(db, eventId): boolean`, `recordEvent(db, eventId, type, provider): void` — used by stripe.ts + finix.ts.
  - `type ChargeStatus = "pending" | "paid" | "failed"`

- [ ] **Step 1: Failing test**

`tests/integration/schema.test.ts`:
```ts
import { desc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { charges, paymentInstruments, plans, subscriptions, users, webhookEvents } from "@/server/db/schema";
import { makeTestDb } from "../helpers/db";

describe("finix schema", () => {
  it("provider defaults, instruments unique-per-user, charges FK", () => {
    const db = makeTestDb("schema");
    const now = Date.now();
    db.insert(users).values({ id: "u1", email: "a@b.c", finixIdentityId: "ID_x", createdAt: now }).run();
    db.insert(subscriptions).values({
      id: "s1", userId: "u1", stripeSubscriptionId: null, stripePriceId: null, planId: "p1",
      status: "incomplete", currentPeriodEnd: now + 1, createdAt: now, updatedAt: now,
    }).run();
    const sub = db.select().from(subscriptions).where(eq(subscriptions.id, "s1")).get()!;
    expect(sub.provider).toBe("stripe");
    expect(sub.consecutiveFailures).toBe(0);

    db.insert(paymentInstruments).values({ id: "pi1", userId: "u1", finixInstrumentId: "PI_x", finixIdentityId: "ID_x", createdAt: now, updatedAt: now }).run();
    // second instrument for same user replaces (upsert on user_id)
    db.insert(paymentInstruments)
      .values({ id: "pi2", userId: "u1", finixInstrumentId: "PI_y", finixIdentityId: "ID_x", createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: paymentInstruments.userId, set: { finixInstrumentId: "PI_y" } })
      .run();
    expect(db.select().from(paymentInstruments).where(eq(paymentInstruments.userId, "u1")).all()).toHaveLength(1);
    db.insert(charges).values({ id: "c1", subscriptionId: "s1", periodStart: now, periodEnd: now + 1, amountCents: 900, currency: "USD", status: "pending", createdAt: now, updatedAt: now }).run();
    // webhook_events: same event id, different provider → two rows
    db.insert(webhookEvents).values({ id: "w1", eventId: "e1", type: "t", provider: "stripe", processedAt: now }).run();
    db.insert(webhookEvents).values({ id: "w2", eventId: "e1", type: "t", provider: "finix", processedAt: now }).run();
    expect(db.select().from(webhookEvents).where(eq(webhookEvents.eventId, "e1")).all()).toHaveLength(2);
  });
});
```

Column nullability: BOTH `stripeSubscriptionId` and `stripePriceId` drop `.notNull()` (keep the unique index on the former) — finix rows store null. `webhook_events` gains ULID `id` PK + `(event_id, provider)` unique, so direct inserts need `id`.

- [ ] **Step 2: Run to confirm fail**

Run: `pnpm vitest run tests/integration/schema.test.ts` — FAIL (columns/tables missing).

- [ ] **Step 3: Implement schema**

In `schema.ts`: users + `finixIdentityId: text("finix_identity_id")`; subscriptions + `provider: text("provider").notNull().default("stripe")`, `finixIdentityId`, `planId: text("plan_id").references(() => plans.id)`, `consecutiveFailures: integer("consecutive_failures").notNull().default(0)`; stripeSubscriptionId → nullable unique. New tables `paymentInstruments` (userId unique FK) and `charges` per spec. `webhookEvents`: `eventId: text("event_id").primaryKey()` → change to non-PK with `provider` — PK must become composite or single-column: use `id: text("id").primaryKey()` ULID + `uniqueIndex` on `(eventId, provider)`. **Decide: composite unique index `uq_webhook_events_event_provider` on (event_id, provider), row id ULID PK.** Export `type PaymentInstrument`, `type Charge`, `type ChargeStatus = "pending" | "paid" | "failed"`.

`src/server/modules/billing/webhookEvents.ts`:
```ts
import "server-only";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulidx";
import type { DB } from "@/server/db/client";
import { webhookEvents } from "@/server/db/schema";

export function seenEvent(db: DB, eventId: string, provider: "stripe" | "finix"): boolean {
  return (
    db.select({ eventId: webhookEvents.eventId })
      .from(webhookEvents)
      .where(and(eq(webhookEvents.eventId, eventId), eq(webhookEvents.provider, provider)))
      .get() !== undefined
  );
}

export function recordEvent(db: DB, eventId: string, type: string, provider: "stripe" | "finix"): void {
  db.insert(webhookEvents)
    .values({ id: ulid(), eventId, type, provider, processedAt: Date.now() })
    .onConflictDoNothing()
    .run();
}
```

Update `stripe.ts` processBillingEvent to use `seenEvent(db, event.id, "stripe")` / `recordEvent(db, event.id, event.type, "stripe")` (replacing its inline seen/record). Behavior identical.

- [ ] **Step 4: `make db-generate` + tests**

Run: `make db-generate && pnpm vitest run` — migration `drizzle/0001_*.sql`; ALL tests green incl. schema.test + existing billing tests (webhook dedupe regression).

- [ ] **Step 5: Commit** — `feat: schema for finix provider — charges, instruments, generalized webhook_events`

---

### Task 2: Finix REST client + signature + outcome mapping

**Files:**
- Create: `src/server/modules/billing/finix.ts` (client layer only for now), `tests/unit/finix.test.ts`
- Modify: `src/server/modules/billing/errors.ts` — new codes

**Interfaces:**
- Produces: `type Finix`, `getFinix()`, `setFinixForTests()`, `finixConfigured()`, `finixRequest()`, `verifyFinixSignature()`, `transferOutcome()`, `ensureIdentity()`, `attachInstrument()`, `postTransfer()`, `type FinixTransfer`; errors + `FINIX_NOT_CONFIGURED`/`FINIX_INSTRUMENT_INVALID`/`FINIX_NO_INSTRUMENT`.

- [ ] **Step 1: Failing unit test** — `tests/unit/finix.test.ts`: transferOutcome table; verifyFinixSignature with forged `timestamp=…,sig=…` (compute via node:crypto in test), tampered sig → false, malformed → false.

- [ ] **Step 2: Implement**

`errors.ts`: add the three codes to the union.

`finix.ts`:
```ts
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DB } from "@/server/db/client";
import { users, type User } from "@/server/db/schema";
import { BillingError } from "./errors";

const DEFAULT_BASE = "https://finix.sandbox-payments-api.com";
const FINIX_VERSION = "2022-02-01";
const TIMEOUT_MS = 15_000;

export type Finix = {
  fetchFn: typeof fetch;
  base: string;
  auth: string;
  merchantId: string;
  applicationId: string;
};

// process.env so tests can inject creds after module load.
let client: Finix | null | undefined;

export function setFinixForTests(stub: Finix | null | undefined): void {
  client = stub;
}

export function finixConfigured(): boolean {
  return !!(process.env.FINIX_USERNAME && process.env.FINIX_PASSWORD && process.env.FINIX_MERCHANT_ID && process.env.FINIX_APPLICATION_ID);
}

export function getFinix(): Finix {
  if (client === undefined) {
    const { FINIX_USERNAME: u, FINIX_PASSWORD: p, FINIX_MERCHANT_ID: m, FINIX_APPLICATION_ID: a } = process.env;
    client =
      u && p && m && a
        ? {
            fetchFn: fetch,
            base: process.env.FINIX_BASE_URL ?? DEFAULT_BASE,
            auth: `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`,
            merchantId: m,
            applicationId: a,
          }
        : null;
  }
  if (!client) throw new BillingError("FINIX_NOT_CONFIGURED");
  return client;
}

export async function finixRequest(
  finix: Finix,
  method: string,
  path: string,
  body?: unknown,
  // biome-ignore lint/suspicious/noExplicitAny: Finix payloads are loosely typed JSON
): Promise<any> {
  const res = await finix.fetchFn(`${finix.base}${path}`, {
    method,
    headers: {
      Authorization: finix.auth,
      "Finix-Version": FINIX_VERSION,
      "Content-Type": "application/vnd.json+api",
      Accept: "application/vnd.json+api",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`finix ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

export type FinixTransfer = {
  id?: string;
  state?: string;
  currency?: string;
  amount?: number;
  entity_id?: string;
  checkout_form_id?: string;
  tags?: Record<string, string>;
  updated_at?: string;
};

/** SUCCEEDED is the only capture; FAILED/CANCELED terminal; else still settling. */
export function transferOutcome(state: string | null | undefined): "paid" | "failed" | "pending" {
  if (state === "SUCCEEDED") return "paid";
  if (state === "FAILED" || state === "CANCELED") return "failed";
  return "pending";
}

/** Finix-Signature: `timestamp=<epoch>,sig=<hex>`; sig = HMAC-SHA256(`${ts}:${rawBody}`, secret). */
export function verifyFinixSignature(payload: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => kv.trim().split("=", 2) as [string, string]),
  );
  const ts = parts.timestamp;
  const sig = parts.sig;
  if (!ts || !sig || !/^\d+$/.test(ts) || !/^[0-9a-f]{64}$/i.test(sig)) return false;
  const expected = createHmac("sha256", secret).update(`${ts}:${payload}`).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(sig, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** users.finix_identity_id get-or-create. Identity payload verified against Finix docs. */
export async function ensureIdentity(db: DB, finix: Finix, user: User): Promise<string> {
  if (user.finixIdentityId) return user.finixIdentityId;
  const identity = await finixRequest(finix, "POST", "/identities", {
    // Finix-hosted-forms convention: application-scoped identity w/ entity block.
    // Fields per Finix API docs; sandbox accepts PERSONAL.
    type: "PERSONAL",
    entity: { email: user.email },
  });
  const id = identity.id as string;
  db.update(users).set({ finixIdentityId: id }).where(eq(users.id, user.id)).run();
  return id;
}

/** Attaches a tokenized PI to the identity — throws FINIX_INSTRUMENT_INVALID on Finix rejection. */
export async function attachInstrument(finix: Finix, identityId: string, instrumentId: string): Promise<void> {
  try {
    await finixRequest(finix, "PUT", `/payment_instruments/${encodeURIComponent(instrumentId)}`, {
      type: "PAYMENT_CARD",
      identity: identityId,
    });
  } catch {
    throw new BillingError("FINIX_INSTRUMENT_INVALID");
  }
}
```

- [ ] **Step 3: Run tests** — `pnpm vitest run tests/unit/finix.test.ts` green; tsc clean.
- [ ] **Step 4: Commit** — `feat: finix rest client, signature verify, identity/instrument helpers`

---

### Task 3: Charge engine — `subscriptions.ts` charge helpers + `tick.ts`

**Files:**
- Modify: `src/server/modules/billing/subscriptions.ts` — period math, charge helpers, `applyChargeOutcome`
- Create: `src/server/modules/billing/tick.ts`
- Test: `tests/unit/periods.test.ts`, `tests/integration/tick.test.ts`

**Interfaces:**
- Consumes: `charges`/`paymentInstruments` tables (T1), `postTransfer`-shaped calls via injected `chargeFn` (T4 supplies `chargeForPeriod`; tick takes it as a param for testability — see below).
- Produces:
  - `periodMs(interval: string): number` (month→30d, year→365d; unknown→30d, documented)
  - `insertCharge(db, {subscriptionId, periodStart, periodEnd, amountCents, currency, attemptNo}): Charge`
  - `hasPendingCharge(db, subscriptionId): boolean`, `latestPendingCharge(db, subscriptionId): Charge | undefined`
  - `applyChargeOutcome(db, charge, outcome: ChargeStatus): void`
  - `runBillingTick(db, chargeFn): Promise<{renewed, retried, canceled, skipped}>` where `chargeFn: (db, sub, charge) => Promise<void>` — injected so tick is pure-DB-testable AND wired to finix's charge later.

Design note for implementer: injecting `chargeFn` keeps Task 3 free of finix.ts → no import ordering hazards; Task 5's route calls `runBillingTick(getDb(), (d, s, c) => chargeForPeriod(d, getFinix(), s, c))`.

- [ ] **Step 1: Failing tests**

`tests/unit/periods.test.ts`: periodMs("month")=2592000000, ("year")=31536000000, ("week")=fallback 30d.

`tests/integration/tick.test.ts` — `chargeFn` stub records calls; fixtures: users+plans+finix subs at various states:
```ts
// cases (each its own it()):
// active + periodEnd past + no pending → renewed++ (chargeFn called w/ new pending charge)
// active + cancelAtPeriodEnd + periodEnd past → canceled++ (status canceled)
// past_due + failures<3 → retried++ (new charge attemptNo = prev+1)
// past_due + failures>=3 → canceled++ (no chargeFn call)
// active + pending charge exists → skipped++
// stripe sub at period end → untouched (skipped)
// applyChargeOutcome: pending charge → paid sets periodEnd=charge.periodEnd, status active, failures=0;
//   failed on incomplete sub → incomplete_expired; failed on active → past_due + failures++
```

- [ ] **Step 2: Implement**

`subscriptions.ts` additions:
```ts
export function periodMs(interval: string): number {
  if (interval === "year") return 365 * 86_400_000;
  return 30 * 86_400_000; // month + unknowns — documented approximation
}

export function insertCharge(
  db: DB,
  c: { subscriptionId: string; periodStart: number; periodEnd: number; amountCents: number; currency: string; attemptNo?: number },
): Charge {
  const now = Date.now();
  const row: typeof charges.$inferInsert = {
    id: ulid(),
    subscriptionId: c.subscriptionId,
    periodStart: c.periodStart,
    periodEnd: c.periodEnd,
    amountCents: c.amountCents,
    currency: c.currency,
    attemptNo: c.attemptNo ?? 1,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
  db.insert(charges).values(row).run();
  return row as Charge;
}

export function hasPendingCharge(db: DB, subscriptionId: string): boolean {
  return (
    db.select({ id: charges.id }).from(charges)
      .where(and(eq(charges.subscriptionId, subscriptionId), eq(charges.status, "pending")))
      .get() !== undefined
  );
}

export function latestPendingCharge(db: DB, subscriptionId: string): Charge | undefined {
  return db.select().from(charges)
    .where(and(eq(charges.subscriptionId, subscriptionId), eq(charges.status, "pending")))
    .orderBy(desc(charges.createdAt)).limit(1).get();
}

const MAX_FAILURES = 3;

/** Applies a settled charge outcome to charge + its finix subscription.
 *  First-charge failure (sub 'incomplete') → incomplete_expired; renewal
 *  failure → past_due + failures++; ≥3 consecutive failures → canceled. */
export function applyChargeOutcome(db: DB, charge: Charge, outcome: ChargeStatus): void {
  const now = Date.now();
  if (outcome === "pending") return;
  db.update(charges).set({ status: outcome, updatedAt: now }).where(eq(charges.id, charge.id)).run();
  const sub = db.select().from(subscriptions).where(eq(subscriptions.id, charge.subscriptionId)).get();
  if (!sub) return;
  if (outcome === "paid") {
    db.update(subscriptions)
      .set({ status: "active", currentPeriodEnd: charge.periodEnd, consecutiveFailures: 0, updatedAt: now })
      .where(eq(subscriptions.id, sub.id)).run();
    return;
  }
  const failures = sub.consecutiveFailures + 1;
  const status =
    sub.status === "incomplete" ? "incomplete_expired" : failures >= MAX_FAILURES ? "canceled" : "past_due";
  db.update(subscriptions)
    .set({ status, consecutiveFailures: failures, updatedAt: now })
    .where(eq(subscriptions.id, sub.id)).run();
}
```

`tick.ts`:
```ts
import "server-only";
import { and, eq, lt } from "drizzle-orm";
import type { DB } from "@/server/db/client";
import { plans, subscriptions, type Charge, type Plan, type Subscription } from "@/server/db/schema";
import { applyChargeOutcome, hasPendingCharge, insertCharge, periodMs } from "./subscriptions";

export type ChargeFn = (db: DB, sub: Subscription, charge: Charge) => Promise<void>;
export type TickCounts = { renewed: number; retried: number; canceled: number; skipped: number };

/**
 * Advances finix subscriptions: renewals at period end, retries while
 * past_due, cancellations. chargeFn performs the provider call and — when
 * the response is already terminal — applies the outcome itself.
 * NEVER touches stripe subs. Skips subs with a pending charge.
 */
export async function runBillingTick(db: DB, chargeFn: ChargeFn): Promise<TickCounts> {
  const now = Date.now();
  const counts: TickCounts = { renewed: 0, retried: 0, canceled: 0, skipped: 0 };
  const subs = db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.provider, "finix"))
    .all();
  for (const sub of subs) {
    if (hasPendingCharge(db, sub.id)) {
      counts.skipped += 1;
      continue;
    }
    const due = sub.currentPeriodEnd !== null && sub.currentPeriodEnd <= now;
    if (sub.status === "active") {
      if (!due) continue;
      if (sub.cancelAtPeriodEnd) {
        db.update(subscriptions).set({ status: "canceled", updatedAt: now }).where(eq(subscriptions.id, sub.id)).run();
        counts.canceled += 1;
        continue;
      }
      const plan = sub.planId ? db.select().from(plans).where(eq(plans.id, sub.planId)).get() : undefined;
      if (!plan) {
        counts.skipped += 1;
        continue;
      }
      const charge = insertCharge(db, {
        subscriptionId: sub.id,
        periodStart: sub.currentPeriodEnd!,
        periodEnd: sub.currentPeriodEnd! + periodMs(plan.interval),
        amountCents: plan.priceCents,
        currency: plan.currency.toUpperCase(),
      });
      await chargeFn(db, sub, charge);
      counts.renewed += 1;
      continue;
    }
    if (sub.status === "past_due") {
      const last = db.select().from(charges).where(eq(charges.subscriptionId, sub.id)).orderBy(desc(charges.createdAt)).limit(1).get();
      const plan = sub.planId ? db.select().from(plans).where(eq(plans.id, sub.planId)).get() : undefined;
      if (!last || !plan) {
        counts.skipped += 1;
        continue;
      }
      const charge = insertCharge(db, {
        subscriptionId: sub.id,
        periodStart: last.periodEnd,
        periodEnd: last.periodEnd + periodMs(plan.interval),
        amountCents: last.amountCents,
        currency: last.currency,
        attemptNo: last.attemptNo + 1,
      });
      await chargeFn(db, sub, charge);
      counts.retried += 1;
    }
  }
  return counts;
}
```
(needs `desc` + `charges` imports added; `lt` unused — drop it.)

- [ ] **Step 3: Run** — `pnpm vitest run` all green.
- [ ] **Step 4: Commit** — `feat: charge ledger helpers + billing tick`

---

### Task 4: Finix subscribe flow — attach+charge+webhook in finix.ts

**Files:**
- Modify: `src/server/modules/billing/finix.ts` — add `createFinixSubscription`, `chargeForPeriod`, `processFinixEvent`, `handleFinixWebhook`, `postTransfer`
- Test: `tests/integration/finix.test.ts`

**Interfaces:**
- Consumes: T2 client, T3 charge helpers.
- Produces:
  - `createFinixSubscription(db, finix, user, plan, paymentInstrumentId): Promise<{subscription: Subscription, charge: Charge}>`
  - `chargeForPeriod(db, finix, sub, charge): Promise<void>` (implements T3's `ChargeFn`)
  - `processFinixEvent(db, event): "APPLIED" | "IGNORED"`
  - `handleFinixWebhook(db, payload, signatureHeader): { status: number }`

- [ ] **Step 1: Failing integration test** — `tests/integration/finix.test.ts`, `fetchFn` stubbed:

```ts
const finixStub = (handler: (path: string, method: string, body?: any) => unknown): Finix => ({
  fetchFn: (async (url: any, init: any) => {
    const path = String(url).replace("https://finix.sandbox-payments-api.com", "");
    const body = init?.body ? JSON.parse(init.body) : undefined;
    const out = handler(path, init?.method ?? "GET", body);
    return new Response(out === null ? null : JSON.stringify(out), { status: 200 });
  }) as unknown as typeof fetch,
  base: "https://finix.sandbox-payments-api.com",
  auth: "Basic x",
  merchantId: "MU_x",
  applicationId: "AP_x",
});
```

Cases:
- happy path: identity POST → `ID_1`; instrument PUT → ok; transfer POST → `{id:"TR_1", state:"SUCCEEDED"}` → sub `active`, charge `paid`, `finixTransferId` recorded, `payment_instruments` row, `users.finix_identity_id` set.
- pending transfer response → sub stays `incomplete`, charge pending.
- webhook: `{type:"entity", entity:"transfer", data:{id:"TR_9", state:"SUCCEEDED", tags:{chargeId}}}` → charge paid + sub active; bad chargeId → IGNORED; same event id replay → IGNORED.
- transfer FAILED on first charge → `incomplete_expired`.
- instrument attach rejects → `FINIX_INSTRUMENT_INVALID`.

Event key rule (implementer): `event.id` if present, else `transfer:${data.id}:${data.state}:${data.updated_at ?? ""}` — deterministic across Finix retries of the same delivery.

- [ ] **Step 2: Implement** (append to finix.ts)

```ts
export async function postTransfer(
  finix: Finix,
  body: { amount: number; currency: string; source: string; merchant_id: string; idempotency_id: string; tags?: Record<string, string> },
): Promise<FinixTransfer> {
  return finixRequest(finix, "POST", "/transfers", { ...body, currency: body.currency.toUpperCase() });
}

/**
 * Tokenized instrument → attached to the user's identity → subscription +
 * first charge created → transfer issued. SUCCEEDED responses settle
 * immediately (fast path); anything else waits for the webhook.
 */
export async function createFinixSubscription(
  db: DB,
  finix: Finix,
  user: User,
  plan: Plan,
  paymentInstrumentId: string,
): Promise<{ subscription: Subscription; charge: Charge }> {
  const identityId = await ensureIdentity(db, finix, user);
  await attachInstrument(finix, identityId, paymentInstrumentId);
  const now = Date.now();
  db.insert(paymentInstruments)
    .values({ id: ulid(), userId: user.id, finixInstrumentId: paymentInstrumentId, finixIdentityId: identityId, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: paymentInstruments.userId, set: { finixInstrumentId: paymentInstrumentId, finixIdentityId: identityId, updatedAt: now } })
    .run();
  const subId = ulid();
  db.insert(subscriptions)
    .values({
      id: subId, userId: user.id, provider: "finix", finixIdentityId: identityId, planId: plan.id,
      stripePriceId: "", status: "incomplete",
      currentPeriodEnd: now + periodMs(plan.interval),
      createdAt: now, updatedAt: now,
    })
    .run();
  const charge = insertCharge(db, {
    subscriptionId: subId, periodStart: now, periodEnd: now + periodMs(plan.interval),
    amountCents: plan.priceCents, currency: plan.currency.toUpperCase(),
  });
  const sub = db.select().from(subscriptions).where(eq(subscriptions.id, subId)).get()!;
  await chargeForPeriod(db, finix, sub, charge);
  return { subscription: sub, charge };
}

/** Charges one period. Terminal transfer states apply immediately;
 *  pending relies on the webhook. Errors propagate (caller 500s → retry). */
export async function chargeForPeriod(db: DB, finix: Finix, sub: Subscription, charge: Charge): Promise<void> {
  const instrument = db.select().from(paymentInstruments).where(eq(paymentInstruments.userId, sub.userId)).get();
  if (!instrument) throw new BillingError("FINIX_NO_INSTRUMENT");
  const t = await postTransfer(finix, {
    amount: charge.amountCents,
    currency: charge.currency,
    source: instrument.finixInstrumentId,
    merchant_id: finix.merchantId,
    idempotency_id: charge.id,
    tags: { chargeId: charge.id, subscriptionId: sub.id },
  });
  db.update(charges).set({ finixTransferId: t.id ?? null, updatedAt: Date.now() }).where(eq(charges.id, charge.id)).run();
  const outcome = transferOutcome(t.state);
  if (outcome !== "pending") applyChargeOutcome(db, { ...charge, finixTransferId: t.id ?? null }, outcome);
}
```

`processFinixEvent` / `handleFinixWebhook`:
```ts
type FinixEvent = { id?: string; type?: string; entity?: string; data?: FinixTransfer };

function finixEventKey(event: FinixEvent, t: FinixTransfer): string {
  return event.id ?? `transfer:${t.id ?? ""}:${t.state ?? ""}:${t.updated_at ?? ""}`;
}

export function processFinixEvent(db: DB, event: FinixEvent): "APPLIED" | "IGNORED" {
  const t = event.data ?? {};
  if (event.entity !== "transfer" || !t.id) return "IGNORED";
  const key = finixEventKey(event, t);
  if (seenEvent(db, key, "finix")) return "IGNORED";

  const chargeId = t.tags?.chargeId;
  const charge =
    (chargeId ? db.select().from(charges).where(eq(charges.id, chargeId)).get() : undefined) ??
    (t.tags?.subscriptionId ? latestPendingCharge(db, t.tags.subscriptionId) : undefined);
  if (!charge) {
    recordEvent(db, key, event.type ?? "transfer", "finix");
    return "IGNORED";
  }
  const outcome = transferOutcome(t.state);
  if (outcome === "pending") {
    recordEvent(db, key, event.type ?? "transfer", "finix");
    return "IGNORED";
  }
  db.update(charges).set({ finixTransferId: t.id, updatedAt: Date.now() }).where(eq(charges.id, charge.id)).run();
  applyChargeOutcome(db, charge, outcome);
  recordEvent(db, key, event.type ?? "transfer", "finix");
  return "APPLIED";
}

export function handleFinixWebhook(db: DB, payload: string, signatureHeader: string | null): { status: number } {
  const secret = process.env.FINIX_WEBHOOK_SECRET;
  if (!secret || !finixConfigured() || !signatureHeader) return { status: 404 };
  if (!verifyFinixSignature(payload, signatureHeader, secret)) return { status: 400 };
  const event = JSON.parse(payload) as FinixEvent;
  processFinixEvent(db, event);
  return { status: 200 };
}
```

Note: `stripePriceId: ""` — the column is NOT NULL today. Either make it nullable in T1's migration (recommended: `stripePriceId` nullable, finix rows null) or keep `""`. **Decision: make it nullable alongside `stripeSubscriptionId` in Task 1** — carry both into T1's migration. Update T1 test accordingly (`stripePriceId: null`).

- [ ] **Step 3: Run** — `pnpm vitest run tests/integration/finix.test.ts tests/integration` green; tsc clean.
- [ ] **Step 4: Commit** — `feat: finix subscribe, charge, webhook event processing`

---

### Task 5: Routes, actions, pages, scripts, docs, verify

**Files:**
- Create: `src/app/api/v1/webhooks/finix/route.ts`, `src/app/api/v1/billing-tick/route.ts`, `src/app/subscribe/finix/page.tsx`, `src/features/billing/finix-form.tsx`, `scripts/finix-webhook-seed.ts`
- Modify: `src/features/billing/actions.ts` (+`finixSubscribe`, `finixCancel`), `src/app/pricing/page.tsx` (Finix button), `src/app/account/billing/page.tsx` (provider-aware), `.env.example`, `Makefile`, `README.md`, `AGENTS.md`, `DESIGN.md`, `docs/{architecture,database,operations,testing}`
- Test: `tests/integration/finix-webhook.test.ts` (forged signature through the real route)

- [ ] **Step 1: Failing route test** — mirror the stripe webhook route test: `vi.mock("@/server/db/client")` getDb → test db; `vi.stubEnv` FINIX_* + `FINIX_WEBHOOK_SECRET`; forge `timestamp=…,sig=…` header via `createHmac`; valid → 200 + settle, bad → 400, secret unset → 404.

- [ ] **Step 2: Implement**

`route.ts` (webhooks/finix):
```ts
import { getDb } from "@/server/db/client";
import { handleFinixWebhook } from "@/server/modules/billing/finix";

export async function POST(req: Request) {
  const payload = await req.text();
  const signature = req.headers.get("finix-signature");
  const result = handleFinixWebhook(getDb(), payload, signature);
  if (result.status === 404) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  if (result.status === 400) return Response.json({ error: "INVALID_SIGNATURE" }, { status: 400 });
  return Response.json({ data: { received: true } }, { status: 200 });
}
```

`route.ts` (billing-tick):
```ts
import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/server/db/client";
import { sessionSecret } from "@/server/env";
import { chargeForPeriod, getFinix } from "@/server/modules/billing/finix";
import { runBillingTick } from "@/server/modules/billing/tick";

export async function POST(req: Request) {
  const secret = sessionSecret();
  const got = req.headers.get("x-billing-secret") ?? "";
  const ok = got.length === secret.length && timingSafeEqual(Buffer.from(got), Buffer.from(secret));
  if (!ok) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  const counts = await runBillingTick(getDb(), (d, s, c) => chargeForPeriod(d, getFinix(), s, c));
  return Response.json({ data: counts }, { status: 200 });
}
```

`actions.ts` additions:
```ts
export async function finixSubscribe(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const plan = getPlanById(getDb(), String(formData.get("planId") ?? ""));
  if (!plan) redirect("/pricing?error=PLAN_NOT_FOUND");
  const instrumentId = String(formData.get("paymentInstrumentId") ?? "");
  if (!instrumentId.startsWith("PI")) redirect("/pricing?error=FINIX_INSTRUMENT_INVALID");
  try {
    const { charge } = await createFinixSubscription(getDb(), getFinix(), user, plan, instrumentId);
    redirect(`/account/billing?${charge.status === "paid" ? "success=1" : "pending=1"}`);
  } catch (e) {
    if (e instanceof BillingError) redirect(`/pricing?error=${e.code}`);
    throw e;
  }
}

export async function finixCancel(): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const sub = getLatestSubscription(getDb(), user.id);
  if (sub?.provider === "finix") {
    getDb().update(subscriptions).set({ cancelAtPeriodEnd: true, updatedAt: Date.now() }).where(eq(subscriptions.id, sub.id)).run();
  }
  redirect("/account/billing");
}
```
(imports: `eq`, `subscriptions`, `createFinixSubscription`, `getFinix`.)

`/subscribe/finix/page.tsx` — server component; `searchParams.planId` → plan lookup (redirect `/pricing?error=PLAN_NOT_FOUND`); renders `<FinixForm applicationId={process.env.FINIX_APPLICATION_ID} planId={plan.id} />`.

`finix-form.tsx` — `"use client"`; `next/script` loads `https://js.finix.com/v1/finix.js`; mounts iframe card fields per Finix.js docs (exact init verified at implementation); on tokenize success writes the returned `PI_…` id into hidden input `paymentInstrumentId` and submits `<form action={finixSubscribe}>`; on failure renders `.error` line. Minimal markup; reuse globals.css.

`/pricing` — under each plan card add, when `finixConfigured()`: `<Link href={\`/subscribe/finix?plan=${p.id}\`}>Pay with Finix</Link>`; when not configured, omit silently (plan card stays Stripe-only).

`/account/billing` — `sub.provider === "finix"`: show provider, `current_period_end` as date, `?pending` notice; replace portal form with `finixCancel` "Cancel at period end" button unless `cancelAtPeriodEnd` already set (then "Cancels at period end").

`scripts/finix-webhook-seed.ts`:
```ts
import { getFinix, finixRequest } from "@/server/modules/billing/finix";
import { appUrl } from "@/server/env";

const finix = getFinix();
const res = await finixRequest(finix, "POST", "/webhooks", {
  url: `${appUrl()}/api/v1/webhooks/finix`,
  enabled: true,
});
console.log("webhook:", res.id ?? res);
console.log("secret:", res.authentication_secret ?? res.secret ?? "(see response)");
console.log(`set FINIX_WEBHOOK_SECRET=<secret> in .env — endpoint: ${appUrl()}/api/v1/webhooks/finix`);
```

`Makefile`: `finix-webhook-seed: ; NODE_OPTIONS="--conditions=react-server" pnpm tsx --env-file-if-exists=.env scripts/finix-webhook-seed.ts` on `.PHONY` + rule.

`.env.example`: `FINIX_WEBHOOK_SECRET=` appended under the FINIX block.

Docs: README (finix section: subscribe via card iframe, `make finix-webhook-seed`, `curl -X POST -H "x-billing-secret: $SESSION_SECRET" localhost:3000/api/v1/billing-tick`), AGENTS.md (asymmetry table + "only tick/webhooks advance finix status" + one-card-per-user), DESIGN.md (new section), docs/architecture+database (charges/payment_instruments/provider columns), operations (finix env + webhook reg + tick), testing (fetchFn stub pattern).

- [ ] **Step 3: Run** — `pnpm vitest run` all green; `make check && make verify` clean.
- [ ] **Step 4: Commit** — `feat: finix routes, subscribe page, billing tick, scripts + docs`

---

## Self-review notes (controller)

- T1 decision embedded: `stripeSubscriptionId` AND `stripePriceId` → nullable (finix rows store null); webhook_events gets ULID `id` PK + `(event_id, provider)` unique.
- `plan_id` on finix rows is REQUIRED by tick; actions must always set it (finixSubscribe does; enforce via NOT NULL only if stripe rows backfill — they can't, so nullable column + finix-only invariant documented).
- `finixSubscribe` gates `PI` prefix locally before calling Finix (cheap rejection of junk inputs).
