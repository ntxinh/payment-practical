import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/server/db/client";
import {
  type Charge,
  charges,
  paymentInstruments,
  plans,
  type Subscription,
  subscriptions,
  type User,
  users,
  webhookEvents,
} from "@/server/db/schema";
import {
  chargeForPeriod,
  createFinixSubscription,
  type Finix,
  finixConfigured,
  handleFinixWebhook,
  processFinixEvent,
} from "@/server/modules/billing/finix";
import { insertCharge, periodMs } from "@/server/modules/billing/subscriptions";
import { makeTestDb } from "../helpers/db";

const NOW = Date.now();
const SECRET = "fwhsec_test";

type Handler = (path: string, method: string, body?: Record<string, unknown>) => unknown;

const finixStub = (handler: Handler): Finix => ({
  fetchFn: (async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url).replace("https://finix.sandbox-payments-api.com", "");
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    const out = handler(path, init?.method ?? "GET", body);
    return new Response(out === null ? null : JSON.stringify(out), { status: 200 });
  }) as unknown as typeof fetch, // stub signature is looser than fetch's
  base: "https://finix.sandbox-payments-api.com",
  auth: "Basic x",
  merchantId: "MU_x",
  applicationId: "AP_x",
});

const must = <T>(v: T | undefined, what: string): T => {
  if (v === undefined) throw new Error(`missing ${what}`);
  return v;
};

const seedUser = (db: DB): User => {
  db.insert(users)
    .values({ id: "u1", email: "u@x.y", stripeCustomerId: "cus_1", createdAt: NOW })
    .run();
  return must(db.select().from(users).where(eq(users.id, "u1")).get(), "user");
};

const seedPlan = (db: DB) => {
  db.insert(plans)
    .values({
      id: "plan_basic",
      slug: "basic",
      name: "Basic",
      priceCents: 999,
      currency: "usd",
      interval: "month",
      createdAt: NOW,
    })
    .run();
  return must(db.select().from(plans).where(eq(plans.id, "plan_basic")).get(), "plan");
};

const getSub = (db: DB, id: string): Subscription =>
  must(db.select().from(subscriptions).where(eq(subscriptions.id, id)).get(), "sub");
const getCharge = (db: DB, id: string): Charge =>
  must(db.select().from(charges).where(eq(charges.id, id)).get(), "charge");

const sign = (payload: string, ts = Math.floor(Date.now() / 1000)): string =>
  `timestamp=${ts},sig=${createHmac("sha256", SECRET).update(`${ts}:${payload}`).digest("hex")}`;

describe("finix subscribe flow", () => {
  let db: DB;
  beforeEach(() => {
    vi.stubEnv("FINIX_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("FINIX_USERNAME", "u");
    vi.stubEnv("FINIX_PASSWORD", "p");
    vi.stubEnv("FINIX_MERCHANT_ID", "MU_x");
    vi.stubEnv("FINIX_APPLICATION_ID", "AP_x");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    db?.$client.close();
  });

  it("happy path: identity → attach → SUCCEEDED transfer settles sub + charge", async () => {
    db = makeTestDb("finix-happy");
    const user = seedUser(db);
    const plan = seedPlan(db);
    const calls: string[] = [];
    const finix = finixStub((path, method, body) => {
      calls.push(`${method} ${path}`);
      if (path === "/identities") return { id: "ID_1" };
      if (path.startsWith("/payment_instruments/")) {
        expect(body?.identity).toBe("ID_1");
        return { id: "PI_1" };
      }
      if (path === "/transfers") {
        expect(body).toMatchObject({
          amount: 999,
          currency: "USD",
          source: "PI_1",
          merchant_id: "MU_x",
        });
        return { id: "TR_1", state: "SUCCEEDED" };
      }
      throw new Error(`unexpected ${method} ${path}`);
    });

    const { subscription, charge } = await createFinixSubscription(db, finix, user, plan, "PI_1");

    expect(calls).toEqual(["POST /identities", "PUT /payment_instruments/PI_1", "POST /transfers"]);
    expect(getSub(db, subscription.id)).toMatchObject({
      provider: "finix",
      status: "active",
      planId: "plan_basic",
      finixIdentityId: "ID_1",
      stripeSubscriptionId: null,
      stripePriceId: null,
      consecutiveFailures: 0,
    });
    expect(charge.status).toBe("paid"); // fast-path settles the returned charge
    expect(getCharge(db, charge.id)).toMatchObject({
      status: "paid",
      finixTransferId: "TR_1",
      amountCents: 999,
      currency: "USD",
    });
    expect(
      db.select().from(paymentInstruments).where(eq(paymentInstruments.userId, "u1")).get(),
    ).toMatchObject({ finixInstrumentId: "PI_1", finixIdentityId: "ID_1" });
    expect(
      must(db.select().from(users).where(eq(users.id, "u1")).get(), "user").finixIdentityId,
    ).toBe("ID_1");
  });

  it("reuses an existing finix identity (no second /identities POST)", async () => {
    db = makeTestDb("finix-reuse");
    db.insert(users)
      .values({ id: "u1", email: "u@x.y", finixIdentityId: "ID_old", createdAt: NOW })
      .run();
    const user = must(db.select().from(users).where(eq(users.id, "u1")).get(), "user");
    const plan = seedPlan(db);
    const finix = finixStub((path) => {
      if (path === "/identities") throw new Error("should not POST /identities");
      if (path.startsWith("/payment_instruments/")) return { id: "PI_1" };
      return { id: "TR_1", state: "SUCCEEDED" };
    });
    const { subscription } = await createFinixSubscription(db, finix, user, plan, "PI_1");
    expect(getSub(db, subscription.id).finixIdentityId).toBe("ID_old");
  });

  it("pending transfer response → sub stays incomplete, charge pending", async () => {
    db = makeTestDb("finix-pending");
    const user = seedUser(db);
    const plan = seedPlan(db);
    const finix = finixStub((path) => {
      if (path === "/identities") return { id: "ID_1" };
      if (path.startsWith("/payment_instruments/")) return { id: "PI_1" };
      return { id: "TR_1", state: "PENDING" };
    });
    const { subscription, charge } = await createFinixSubscription(db, finix, user, plan, "PI_1");
    expect(getSub(db, subscription.id).status).toBe("incomplete");
    expect(getCharge(db, charge.id)).toMatchObject({
      status: "pending",
      finixTransferId: "TR_1",
    });
  });

  it("FAILED transfer on first charge → incomplete_expired", async () => {
    db = makeTestDb("finix-fail-first");
    const user = seedUser(db);
    const plan = seedPlan(db);
    const finix = finixStub((path) => {
      if (path === "/identities") return { id: "ID_1" };
      if (path.startsWith("/payment_instruments/")) return { id: "PI_1" };
      return { id: "TR_1", state: "FAILED" };
    });
    const { subscription, charge } = await createFinixSubscription(db, finix, user, plan, "PI_1");
    expect(getSub(db, subscription.id).status).toBe("incomplete_expired");
    expect(getCharge(db, charge.id).status).toBe("failed");
  });

  it("instrument attach rejection → FINIX_INSTRUMENT_INVALID, no sub/instrument rows", async () => {
    db = makeTestDb("finix-bad-pi");
    const user = seedUser(db);
    const plan = seedPlan(db);
    const failing: Finix = {
      ...finixStub(() => ({})),
      fetchFn: (async (url: RequestInfo | URL) => {
        const path = String(url).replace("https://finix.sandbox-payments-api.com", "");
        if (path === "/identities") return new Response(JSON.stringify({ id: "ID_1" }));
        if (path.startsWith("/payment_instruments/"))
          return new Response("rejected", { status: 400 });
        return new Response(JSON.stringify({}), { status: 200 });
      }) as unknown as typeof fetch, // stub signature is looser than fetch's
    };
    await expect(createFinixSubscription(db, failing, user, plan, "PI_bad")).rejects.toMatchObject({
      name: "BillingError",
      code: "FINIX_INSTRUMENT_INVALID",
    });
    expect(db.select().from(subscriptions).all()).toHaveLength(0);
    expect(db.select().from(paymentInstruments).all()).toHaveLength(0);
    expect(db.select().from(charges).all()).toHaveLength(0);
  });

  it("chargeForPeriod without an instrument → FINIX_NO_INSTRUMENT", async () => {
    db = makeTestDb("finix-no-instr");
    seedUser(db);
    const plan = seedPlan(db);
    db.insert(subscriptions)
      .values({
        id: "s1",
        userId: "u1",
        provider: "finix",
        planId: plan.id,
        status: "active",
        currentPeriodEnd: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    const sub = getSub(db, "s1");
    const charge = insertCharge(db, {
      subscriptionId: "s1",
      periodStart: NOW,
      periodEnd: NOW + periodMs("month"),
      amountCents: 999,
      currency: "USD",
    });
    const finix = finixStub(() => {
      throw new Error("no calls expected");
    });
    await expect(chargeForPeriod(db, finix, sub, charge)).rejects.toMatchObject({
      code: "FINIX_NO_INSTRUMENT",
    });
  });
});

describe("processFinixEvent", () => {
  let db: DB;
  afterEach(() => db?.$client.close());

  const seedPendingCharge = () => {
    db = makeTestDb("finix-evt");
    seedUser(db);
    seedPlan(db);
    db.insert(subscriptions)
      .values({
        id: "s1",
        userId: "u1",
        provider: "finix",
        planId: "plan_basic",
        status: "incomplete",
        currentPeriodEnd: NOW + periodMs("month"),
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    return insertCharge(db, {
      subscriptionId: "s1",
      periodStart: NOW,
      periodEnd: NOW + periodMs("month"),
      amountCents: 999,
      currency: "USD",
    });
  };

  it("transfer SUCCEEDED event → APPLIED, charge paid + sub active", () => {
    const charge = seedPendingCharge();
    const res = processFinixEvent(db, {
      id: "EV_1",
      type: "entity",
      entity: "transfer",
      data: { id: "TR_9", state: "SUCCEEDED", tags: { chargeId: charge.id } },
    });
    expect(res).toBe("APPLIED");
    expect(getCharge(db, charge.id)).toMatchObject({
      status: "paid",
      finixTransferId: "TR_9",
    });
    expect(getSub(db, "s1").status).toBe("active");
  });

  it("same event id replayed → IGNORED, no re-apply", () => {
    const charge = seedPendingCharge();
    const event = {
      id: "EV_dup",
      type: "entity",
      entity: "transfer",
      data: { id: "TR_9", state: "SUCCEEDED", tags: { chargeId: charge.id } },
    };
    expect(processFinixEvent(db, event)).toBe("APPLIED");
    expect(processFinixEvent(db, event)).toBe("IGNORED");
    expect(db.select().from(webhookEvents).all()).toHaveLength(1);
  });

  it("unknown chargeId and no subscriptionId → IGNORED (recorded)", () => {
    seedPendingCharge();
    const res = processFinixEvent(db, {
      id: "EV_bad",
      entity: "transfer",
      data: { id: "TR_x", state: "SUCCEEDED", tags: { chargeId: "nope" } },
    });
    expect(res).toBe("IGNORED");
    expect(
      db.select().from(webhookEvents).where(eq(webhookEvents.eventId, "EV_bad")).all(),
    ).toHaveLength(1);
  });

  it("event for a non-pending charge → IGNORED (no re-apply)", () => {
    const charge = seedPendingCharge();
    // settle the charge first, then a late SUCCEEDED event must not re-apply
    db.update(charges).set({ status: "paid" }).where(eq(charges.id, charge.id)).run();
    const res = processFinixEvent(db, {
      id: "EV_late",
      entity: "transfer",
      data: { id: "TR_9", state: "SUCCEEDED", tags: { chargeId: charge.id } },
    });
    expect(res).toBe("IGNORED");
    expect(
      db.select().from(webhookEvents).where(eq(webhookEvents.eventId, "EV_late")).all(),
    ).toHaveLength(1);
  });

  it("resolves pending charge via tags.subscriptionId when chargeId absent", () => {
    const charge = seedPendingCharge();
    const res = processFinixEvent(db, {
      id: "EV_sub",
      entity: "transfer",
      data: {
        id: "TR_9",
        state: "FAILED",
        tags: { subscriptionId: "s1" },
      },
    });
    expect(res).toBe("APPLIED");
    expect(getCharge(db, charge.id).status).toBe("failed");
    expect(getSub(db, "s1").status).toBe("incomplete_expired");
  });

  it("non-transfer entity / missing id → IGNORED, not recorded", () => {
    seedPendingCharge();
    expect(processFinixEvent(db, { id: "EV_a", entity: "merchant", data: {} })).toBe("IGNORED");
    expect(processFinixEvent(db, { entity: "transfer", data: {} })).toBe("IGNORED");
    expect(db.select().from(webhookEvents).all()).toHaveLength(0);
  });

  it("pending transfer state → IGNORED (recorded, no status change)", () => {
    const charge = seedPendingCharge();
    const res = processFinixEvent(db, {
      entity: "transfer",
      data: {
        id: "TR_9",
        state: "PENDING",
        tags: { chargeId: charge.id },
      },
    });
    expect(res).toBe("IGNORED");
    expect(getCharge(db, charge.id).status).toBe("pending");
    expect(db.select().from(webhookEvents).all()).toHaveLength(1);
  });
});

describe("handleFinixWebhook", () => {
  let db: DB;
  beforeEach(() => {
    vi.stubEnv("FINIX_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("FINIX_USERNAME", "u");
    vi.stubEnv("FINIX_PASSWORD", "p");
    vi.stubEnv("FINIX_MERCHANT_ID", "MU_x");
    vi.stubEnv("FINIX_APPLICATION_ID", "AP_x");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    db?.$client.close();
  });

  const seedPendingCharge = () => {
    db = makeTestDb("finix-wh");
    seedUser(db);
    seedPlan(db);
    db.insert(subscriptions)
      .values({
        id: "s1",
        userId: "u1",
        provider: "finix",
        planId: "plan_basic",
        status: "incomplete",
        currentPeriodEnd: NOW + periodMs("month"),
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    return insertCharge(db, {
      subscriptionId: "s1",
      periodStart: NOW,
      periodEnd: NOW + periodMs("month"),
      amountCents: 999,
      currency: "USD",
    });
  };

  it("404 without secret / creds / signature header", () => {
    db = makeTestDb("finix-wh-404");
    vi.stubEnv("FINIX_WEBHOOK_SECRET", "");
    expect(handleFinixWebhook(db, "{}", sign("{}"))).toEqual({ status: 404 });
    vi.stubEnv("FINIX_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("FINIX_USERNAME", "");
    expect(finixConfigured()).toBe(false);
    expect(handleFinixWebhook(db, "{}", sign("{}"))).toEqual({ status: 404 });
    vi.stubEnv("FINIX_USERNAME", "u");
    expect(handleFinixWebhook(db, "{}", null)).toEqual({ status: 404 });
  });

  it("400 on bad signature", () => {
    db = makeTestDb("finix-wh-badsig");
    expect(handleFinixWebhook(db, "{}", "timestamp=1,sig=deadbeef")).toEqual({ status: 400 });
  });

  it("400 on stale timestamp (>300s skew)", () => {
    db = makeTestDb("finix-wh-stale");
    const payload = JSON.stringify({ entity: "transfer", data: {} });
    const stale = Math.floor(Date.now() / 1000) - 301;
    expect(handleFinixWebhook(db, payload, sign(payload, stale))).toEqual({ status: 400 });
    const future = Math.floor(Date.now() / 1000) + 301;
    expect(handleFinixWebhook(db, payload, sign(payload, future))).toEqual({ status: 400 });
  });

  it("200 + applies a valid transfer event end-to-end", () => {
    const charge = seedPendingCharge();
    const payload = JSON.stringify({
      id: "EV_rt",
      type: "entity",
      entity: "transfer",
      data: { id: "TR_9", state: "SUCCEEDED", tags: { chargeId: charge.id } },
    });
    expect(handleFinixWebhook(db, payload, sign(payload))).toEqual({ status: 200 });
    expect(getCharge(db, charge.id)).toMatchObject({ status: "paid", finixTransferId: "TR_9" });
    expect(getSub(db, "s1").status).toBe("active");
  });

  it("200 boundary: timestamp == now is fresh", () => {
    db = makeTestDb("finix-wh-fresh");
    const payload = JSON.stringify({ entity: "transfer", data: {} });
    expect(handleFinixWebhook(db, payload, sign(payload))).toEqual({ status: 200 });
  });
});

describe("fix round 1", () => {
  let db: DB;
  beforeEach(() => {
    vi.stubEnv("FINIX_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("FINIX_USERNAME", "u");
    vi.stubEnv("FINIX_PASSWORD", "p");
    vi.stubEnv("FINIX_MERCHANT_ID", "MU_x");
    vi.stubEnv("FINIX_APPLICATION_ID", "AP_x");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    db?.$client.close();
  });

  it("400 when a fresh timestamp is prepended to a stale signed delivery (last-wins parse)", () => {
    db = makeTestDb("finix-wh-prepend");
    const payload = JSON.stringify({ entity: "transfer", data: {} });
    const stale = Math.floor(Date.now() / 1000) - 301;
    // Sig is over the OLD timestamp; attacker prepends a fresh one.
    const header = `timestamp=${Math.floor(Date.now() / 1000)},${sign(payload, stale)}`;
    expect(handleFinixWebhook(db, payload, header)).toEqual({ status: 400 });
  });

  it("200 when the sig itself is fresh and prepended junk is ignored", () => {
    db = makeTestDb("finix-wh-prepend-ok");
    const payload = JSON.stringify({ entity: "transfer", data: {} });
    // Junk key first, valid header entries after — parse takes the real ts/sig.
    const header = `junk=1,${sign(payload)}`;
    expect(handleFinixWebhook(db, payload, header)).toEqual({ status: 200 });
  });

  it("FINIX_SUB_EXISTS when the user already has a live finix sub", async () => {
    db = makeTestDb("finix-sub-exists");
    const user = seedUser(db);
    const plan = seedPlan(db);
    db.insert(subscriptions)
      .values({
        id: "s_live",
        userId: "u1",
        provider: "finix",
        planId: plan.id,
        status: "incomplete",
        currentPeriodEnd: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    const finix = finixStub(() => {
      throw new Error("no provider calls expected");
    });
    await expect(createFinixSubscription(db, finix, user, plan, "PI_1")).rejects.toMatchObject({
      name: "BillingError",
      code: "FINIX_SUB_EXISTS",
    });
    expect(db.select().from(subscriptions).all()).toHaveLength(1);
    expect(db.select().from(charges).all()).toHaveLength(0);
  });

  it("retry allowed after incomplete_expired (dead sub doesn't block)", async () => {
    db = makeTestDb("finix-sub-retry");
    const user = seedUser(db);
    const plan = seedPlan(db);
    db.insert(subscriptions)
      .values({
        id: "s_dead",
        userId: "u1",
        provider: "finix",
        planId: plan.id,
        status: "incomplete_expired",
        currentPeriodEnd: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    const finix = finixStub((path) => {
      if (path === "/identities") return { id: "ID_1" };
      if (path.startsWith("/payment_instruments/")) return { id: "PI_1" };
      return { id: "TR_1", state: "SUCCEEDED" };
    });
    const { subscription } = await createFinixSubscription(db, finix, user, plan, "PI_1");
    expect(subscription.id).not.toBe("s_dead");
    expect(subscription.status).toBe("active");
    expect(db.select().from(subscriptions).all()).toHaveLength(2);
  });
});
