import { eq } from "drizzle-orm";
import { ulid } from "ulidx";
import { afterEach, describe, expect, it } from "vitest";
import type { DB } from "@/server/db/client";
import {
  type Charge,
  type ChargeStatus,
  charges,
  plans,
  type Subscription,
  subscriptions,
  users,
} from "@/server/db/schema";
import {
  applyChargeOutcome,
  insertCharge,
  type NewCharge,
  periodMs,
} from "@/server/modules/billing/subscriptions";
import { type ChargeFn, runBillingTick } from "@/server/modules/billing/tick";
import { makeTestDb } from "../helpers/db";

type SubInsert = typeof subscriptions.$inferInsert;

const NOW = Date.now();
const PAST = NOW - 86_400_000;
const FUTURE = NOW + 86_400_000;
const DAY = 86_400_000;
const PLAN_ID = "plan_basic";

const seedBase = (db: DB) => {
  db.insert(users)
    .values({ id: "u1", email: "u@x.y", stripeCustomerId: "cus_1", createdAt: NOW })
    .run();
  db.insert(plans)
    .values({
      id: PLAN_ID,
      slug: "basic",
      name: "Basic",
      priceCents: 999,
      currency: "usd",
      interval: "month",
      createdAt: NOW,
    })
    .run();
};

const must = <T>(v: T | undefined, what: string): T => {
  if (v === undefined) throw new Error(`missing ${what}`);
  return v;
};

const subRow = (id: string, provider: string, over: Partial<SubInsert>): SubInsert => ({
  id,
  userId: "u1",
  provider,
  status: "active",
  currentPeriodEnd: PAST,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const finixSub = (over: Partial<SubInsert> = {}): SubInsert =>
  subRow("sub_f", "finix", { planId: PLAN_ID, ...over });

const insertSub = (db: DB, row: SubInsert): Subscription => {
  db.insert(subscriptions).values(row).run();
  return must(db.select().from(subscriptions).where(eq(subscriptions.id, row.id)).get(), "sub");
};

const getSub = (db: DB, id: string): Subscription =>
  must(db.select().from(subscriptions).where(eq(subscriptions.id, id)).get(), "sub");

const getCharges = (db: DB, subId: string): Charge[] =>
  db.select().from(charges).where(eq(charges.subscriptionId, subId)).all();

const settleCharge: (outcome: ChargeStatus) => ChargeFn = (outcome) => async (db, _sub, charge) =>
  applyChargeOutcome(db, charge, outcome);

describe("runBillingTick", () => {
  let db: DB;
  afterEach(() => db?.$client.close());

  it("active + periodEnd past + no pending → renewed (chargeFn gets new pending charge)", async () => {
    db = makeTestDb("tick-renew");
    seedBase(db);
    insertSub(db, finixSub());

    const calls: Charge[] = [];
    const counts = await runBillingTick(db, async (_d, _s, c) => {
      calls.push(c);
    });

    expect(counts).toEqual({ renewed: 1, retried: 0, canceled: 0, skipped: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      subscriptionId: "sub_f",
      status: "pending",
      attemptNo: 1,
      amountCents: 999,
      currency: "USD",
      periodStart: PAST,
      periodEnd: PAST + periodMs("month"),
    });
  });

  it("active + not yet due → untouched", async () => {
    db = makeTestDb("tick-notdue");
    seedBase(db);
    insertSub(db, finixSub({ currentPeriodEnd: FUTURE }));

    const calls: Charge[] = [];
    const counts = await runBillingTick(db, async (_d, _s, c) => {
      calls.push(c);
    });

    expect(counts).toEqual({ renewed: 0, retried: 0, canceled: 0, skipped: 0 });
    expect(calls).toHaveLength(0);
    expect(getCharges(db, "sub_f")).toHaveLength(0);
  });

  it("active + cancelAtPeriodEnd + periodEnd past → canceled, no charge", async () => {
    db = makeTestDb("tick-cancel-eop");
    seedBase(db);
    insertSub(db, finixSub({ cancelAtPeriodEnd: true }));

    const calls: Charge[] = [];
    const counts = await runBillingTick(db, async (_d, _s, c) => {
      calls.push(c);
    });

    expect(counts).toEqual({ renewed: 0, retried: 0, canceled: 1, skipped: 0 });
    expect(calls).toHaveLength(0);
    expect(getSub(db, "sub_f").status).toBe("canceled");
    expect(getCharges(db, "sub_f")).toHaveLength(0);
  });

  it("past_due + failures<3 → retried with attemptNo = prev+1", async () => {
    db = makeTestDb("tick-retry");
    seedBase(db);
    const sub = insertSub(
      db,
      finixSub({ status: "past_due", consecutiveFailures: 1, currentPeriodEnd: PAST }),
    );
    const prev = insertCharge(db, {
      subscriptionId: sub.id,
      periodStart: PAST - 30 * DAY,
      periodEnd: PAST,
      amountCents: 999,
      currency: "USD",
      attemptNo: 1,
    });
    db.update(charges)
      .set({ status: "failed", finixTransferId: "TR_prev" }) // stamped = normal settled failure
      .where(eq(charges.id, prev.id))
      .run();

    const calls: Charge[] = [];
    const counts = await runBillingTick(db, async (_d, _s, c) => {
      calls.push(c);
    });

    expect(counts).toEqual({ renewed: 0, retried: 1, canceled: 0, skipped: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].attemptNo).toBe(2);
    expect(calls[0].periodStart).toBe(PAST);
    expect(calls[0].periodEnd).toBe(PAST + periodMs("month"));
  });

  it("past_due + last charge failed w/o transfer id → retries the SAME charge (idempotency)", async () => {
    db = makeTestDb("tick-reuse");
    seedBase(db);
    const sub = insertSub(
      db,
      finixSub({ status: "past_due", consecutiveFailures: 1, currentPeriodEnd: PAST }),
    );
    const prev = insertCharge(db, {
      subscriptionId: sub.id,
      periodStart: PAST - 30 * DAY,
      periodEnd: PAST,
      amountCents: 999,
      currency: "USD",
      attemptNo: 1,
    });
    // Simulate the postTransfer-throw path: failed, never stamped.
    db.update(charges)
      .set({ status: "failed", finixTransferId: null })
      .where(eq(charges.id, prev.id))
      .run();

    const calls: Charge[] = [];
    const counts = await runBillingTick(db, async (_d, _s, c) => {
      calls.push(c);
    });

    expect(counts).toEqual({ renewed: 0, retried: 1, canceled: 0, skipped: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe(prev.id); // same row → same idempotency key
    expect(getCharges(db, sub.id)).toHaveLength(1); // no second charge row
  });

  it("past_due + cancelAtPeriodEnd → canceled without retry", async () => {
    db = makeTestDb("tick-cancel-pastdue");
    seedBase(db);
    const sub = insertSub(
      db,
      finixSub({
        status: "past_due",
        consecutiveFailures: 1,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: PAST,
      }),
    );
    const prev = insertCharge(db, {
      subscriptionId: sub.id,
      periodStart: PAST - 30 * DAY,
      periodEnd: PAST,
      amountCents: 999,
      currency: "USD",
      attemptNo: 1,
    });
    db.update(charges).set({ status: "failed" }).where(eq(charges.id, prev.id)).run();

    const calls: Charge[] = [];
    const counts = await runBillingTick(db, async (_d, _s, c) => {
      calls.push(c);
    });

    expect(counts).toEqual({ renewed: 0, retried: 0, canceled: 1, skipped: 0 });
    expect(calls).toHaveLength(0);
    expect(getSub(db, sub.id).status).toBe("canceled");
  });

  it("past_due + failures=2 + failed retry → canceled via applyChargeOutcome (3rd failure)", async () => {
    db = makeTestDb("tick-3rd-fail");
    seedBase(db);
    const sub = insertSub(
      db,
      finixSub({ status: "past_due", consecutiveFailures: 2, currentPeriodEnd: PAST }),
    );
    const prev = insertCharge(db, {
      subscriptionId: sub.id,
      periodStart: PAST - 30 * DAY,
      periodEnd: PAST,
      amountCents: 999,
      currency: "USD",
      attemptNo: 2,
    });
    db.update(charges).set({ status: "failed" }).where(eq(charges.id, prev.id)).run();

    const counts = await runBillingTick(db, settleCharge("failed"));

    expect(counts).toEqual({ renewed: 0, retried: 1, canceled: 0, skipped: 0 });
    expect(getSub(db, "sub_f")).toMatchObject({ status: "canceled", consecutiveFailures: 3 });
  });

  it("past_due + failures>=3 → canceled without charging", async () => {
    db = makeTestDb("tick-max-fail");
    seedBase(db);
    insertSub(db, finixSub({ status: "past_due", consecutiveFailures: 3, currentPeriodEnd: PAST }));

    const calls: Charge[] = [];
    const counts = await runBillingTick(db, async (_d, _s, c) => {
      calls.push(c);
    });

    expect(counts).toEqual({ renewed: 0, retried: 0, canceled: 1, skipped: 0 });
    expect(calls).toHaveLength(0);
    expect(getSub(db, "sub_f").status).toBe("canceled");
    expect(getCharges(db, "sub_f")).toHaveLength(0);
  });

  it("sub with a pending charge → skipped", async () => {
    db = makeTestDb("tick-pending");
    seedBase(db);
    const sub = insertSub(db, finixSub());
    insertCharge(db, {
      subscriptionId: sub.id,
      periodStart: PAST,
      periodEnd: PAST + periodMs("month"),
      amountCents: 999,
      currency: "USD",
    });

    const calls: Charge[] = [];
    const counts = await runBillingTick(db, async (_d, _s, c) => {
      calls.push(c);
    });

    expect(counts).toEqual({ renewed: 0, retried: 0, canceled: 0, skipped: 1 });
    expect(calls).toHaveLength(0);
  });

  it("stripe sub at period end → untouched", async () => {
    db = makeTestDb("tick-stripe");
    seedBase(db);
    insertSub(
      db,
      subRow("sub_s", "stripe", {
        stripeSubscriptionId: "stripe_sub_1",
        planId: null,
        currentPeriodEnd: PAST,
      }),
    );

    const calls: Charge[] = [];
    const counts = await runBillingTick(db, async (_d, _s, c) => {
      calls.push(c);
    });

    expect(counts).toEqual({ renewed: 0, retried: 0, canceled: 0, skipped: 0 });
    expect(calls).toHaveLength(0);
    expect(getSub(db, "sub_s").status).toBe("active");
    expect(getCharges(db, "sub_s")).toHaveLength(0);
  });
});

describe("applyChargeOutcome", () => {
  let db: DB;
  afterEach(() => db?.$client.close());

  const seedCharge = (
    subOver: Partial<SubInsert> = {},
    chargeOver: Partial<NewCharge> = {},
  ): { sub: Subscription; charge: Charge } => {
    db = makeTestDb(`aco-${ulid()}`);
    seedBase(db);
    const sub = insertSub(db, finixSub(subOver));
    const charge = insertCharge(db, {
      subscriptionId: sub.id,
      periodStart: PAST,
      periodEnd: FUTURE,
      amountCents: 999,
      currency: "USD",
      ...chargeOver,
    });
    return { sub, charge };
  };

  const getCharge = (id: string): Charge =>
    must(db.select().from(charges).where(eq(charges.id, id)).get(), "charge");

  it("pending outcome → no-op", () => {
    const { sub, charge } = seedCharge();
    applyChargeOutcome(db, charge, "pending");
    expect(getCharge(charge.id).status).toBe("pending");
    expect(getSub(db, sub.id)).toMatchObject(sub);
  });

  it("paid → charge paid, periodEnd = charge.periodEnd, status active, failures 0", () => {
    const { sub, charge } = seedCharge(
      { status: "past_due", consecutiveFailures: 2, currentPeriodEnd: PAST },
      { attemptNo: 2 },
    );
    applyChargeOutcome(db, charge, "paid");
    expect(getCharge(charge.id).status).toBe("paid");
    expect(getSub(db, sub.id)).toMatchObject({
      status: "active",
      currentPeriodEnd: FUTURE,
      consecutiveFailures: 0,
    });
  });

  it("failed on incomplete sub → incomplete_expired", () => {
    const { sub, charge } = seedCharge({ status: "incomplete", currentPeriodEnd: null });
    applyChargeOutcome(db, charge, "failed");
    expect(getSub(db, sub.id)).toMatchObject({
      status: "incomplete_expired",
      consecutiveFailures: 1,
    });
  });

  it("failed on active sub → past_due + failures++", () => {
    const { sub, charge } = seedCharge();
    applyChargeOutcome(db, charge, "failed");
    expect(getSub(db, sub.id)).toMatchObject({
      status: "past_due",
      consecutiveFailures: 1,
    });
  });

  it("failed on past_due sub at failures=2 → canceled", () => {
    const { sub, charge } = seedCharge({ status: "past_due", consecutiveFailures: 2 });
    applyChargeOutcome(db, charge, "failed");
    expect(getSub(db, sub.id)).toMatchObject({
      status: "canceled",
      consecutiveFailures: 3,
    });
  });
});
