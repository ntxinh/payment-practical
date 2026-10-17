import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { afterEach, describe, expect, it } from "vitest";
import type { DB } from "@/server/db/client";
import { subscriptions, users } from "@/server/db/schema";
import { processBillingEvent } from "@/server/modules/billing/stripe";
import { makeTestDb } from "../helpers/db";

const user = {
  id: "u1",
  email: "u@x.y",
  stripeCustomerId: "cus_1",
  finixIdentityId: null,
  createdAt: Date.now(),
};

const stripeSub = (over: Partial<Stripe.Subscription> = {}): Stripe.Subscription =>
  ({
    id: "sub_1",
    status: "active",
    customer: "cus_1",
    metadata: { userId: user.id },
    cancel_at_period_end: false,
    items: { data: [{ price: { id: "price_1" }, current_period_end: 1_800_000_000 }] },
    ...over,
  }) as unknown as Stripe.Subscription;

const event = (type: string, object: unknown): Stripe.Event =>
  ({ id: `evt_${type}`, type, data: { object } }) as unknown as Stripe.Event;

const stripeClient = {
  subscriptions: { retrieve: async () => stripeSub() },
} as unknown as Stripe;

describe("processBillingEvent", () => {
  let db: DB;
  afterEach(() => db?.$client.close());

  const seed = () => {
    db = makeTestDb("billing");
    db.insert(users).values(user).run();
  };

  it("checkout.session.completed → active subscription row", async () => {
    seed();
    const session = { mode: "subscription", subscription: "sub_1" };
    const out = await processBillingEvent(
      db,
      stripeClient,
      event("checkout.session.completed", session),
    );
    expect(out).toBe("APPLIED");
    const row = db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, "sub_1"))
      .get();
    expect(row?.status).toBe("active");
    expect(row?.userId).toBe(user.id);
    expect(row?.currentPeriodEnd).toBe(1_800_000_000_000); // s → ms
  });

  it("replaying the same event id is ignored (idempotent)", async () => {
    seed();
    const e = event("customer.subscription.updated", stripeSub());
    await processBillingEvent(db, stripeClient, e);
    const second = await processBillingEvent(db, stripeClient, e);
    expect(second).toBe("IGNORED");
    expect(db.select().from(subscriptions).all()).toHaveLength(1);
  });

  it("customer.subscription.deleted → canceled", async () => {
    seed();
    await processBillingEvent(
      db,
      stripeClient,
      event("customer.subscription.updated", stripeSub()),
    );
    await processBillingEvent(
      db,
      stripeClient,
      event("customer.subscription.deleted", stripeSub({ status: "canceled" })),
    );
    const row = db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, "sub_1"))
      .get();
    expect(row?.status).toBe("canceled");
  });

  it("unresolvable user → IGNORED (no row)", async () => {
    seed();
    const out = await processBillingEvent(
      db,
      stripeClient,
      event("customer.subscription.updated", stripeSub({ metadata: {}, customer: "cus_unknown" })),
    );
    expect(out).toBe("IGNORED");
    expect(db.select().from(subscriptions).all()).toHaveLength(0);
  });

  it("portalUrlForUser without stripe customer → NO_STRIPE_CUSTOMER", async () => {
    // Dynamic import: exercises module-load boundary — stripe.ts must load without STRIPE_* env keys.
    const { portalUrlForUser } = await import("@/server/modules/billing/stripe");
    const bare = { ...user, stripeCustomerId: null };
    await expect(portalUrlForUser(bare)).rejects.toMatchObject({ code: "NO_STRIPE_CUSTOMER" });
  });
  it("thrown retrieve error is NOT recorded → same event id re-processes on retry", async () => {
    seed();
    let calls = 0;
    const flaky = {
      subscriptions: {
        retrieve: async () => {
          calls += 1;
          if (calls === 1) throw new Error("stripe 503");
          return stripeSub();
        },
      },
    } as unknown as Stripe;
    const e = event("checkout.session.completed", { mode: "subscription", subscription: "sub_1" });
    await expect(processBillingEvent(db, flaky, e)).rejects.toThrow("stripe 503");
    expect(await processBillingEvent(db, flaky, e)).toBe("APPLIED");
    expect(db.select().from(subscriptions).all()).toHaveLength(1);
    expect(calls).toBe(2);
  });
});
