import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  charges,
  paymentInstruments,
  plans,
  subscriptions,
  users,
  webhookEvents,
} from "@/server/db/schema";
import { makeTestDb } from "../helpers/db";

describe("finix schema", () => {
  it("provider defaults, instruments unique-per-user, charges FK", () => {
    const db = makeTestDb("schema");
    const now = Date.now();
    db.insert(users)
      .values({ id: "u1", email: "a@b.c", finixIdentityId: "ID_x", createdAt: now })
      .run();
    db.insert(plans)
      .values({
        id: "p1",
        slug: "p1",
        name: "P1",
        priceCents: 900,
        currency: "USD",
        interval: "month",
        createdAt: now,
      })
      .run();
    db.insert(subscriptions)
      .values({
        id: "s1",
        userId: "u1",
        stripeSubscriptionId: null,
        stripePriceId: null,
        planId: "p1",
        status: "incomplete",
        currentPeriodEnd: now + 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const sub = db.select().from(subscriptions).where(eq(subscriptions.id, "s1")).get();
    expect(sub?.provider).toBe("stripe");
    expect(sub?.consecutiveFailures).toBe(0);

    db.insert(paymentInstruments)
      .values({
        id: "pi1",
        userId: "u1",
        finixInstrumentId: "PI_x",
        finixIdentityId: "ID_x",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    // second instrument for same user replaces (upsert on user_id)
    db.insert(paymentInstruments)
      .values({
        id: "pi2",
        userId: "u1",
        finixInstrumentId: "PI_y",
        finixIdentityId: "ID_x",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: paymentInstruments.userId,
        set: { finixInstrumentId: "PI_y" },
      })
      .run();
    expect(
      db.select().from(paymentInstruments).where(eq(paymentInstruments.userId, "u1")).all(),
    ).toHaveLength(1);
    db.insert(charges)
      .values({
        id: "c1",
        subscriptionId: "s1",
        periodStart: now,
        periodEnd: now + 1,
        amountCents: 900,
        currency: "USD",
        status: "pending",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    // webhook_events: same event id, different provider → two rows
    db.insert(webhookEvents)
      .values({ id: "w1", eventId: "e1", type: "t", provider: "stripe", processedAt: now })
      .run();
    db.insert(webhookEvents)
      .values({ id: "w2", eventId: "e1", type: "t", provider: "finix", processedAt: now })
      .run();
    expect(
      db.select().from(webhookEvents).where(eq(webhookEvents.eventId, "e1")).all(),
    ).toHaveLength(2);
  });
});
