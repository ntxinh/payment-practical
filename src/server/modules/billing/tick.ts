import "server-only";
import { desc, eq } from "drizzle-orm";
import type { DB } from "@/server/db/client";
import { type Charge, charges, plans, type Subscription, subscriptions } from "@/server/db/schema";
import { hasPendingCharge, insertCharge, periodMs } from "./subscriptions";

export type ChargeFn = (db: DB, sub: Subscription, charge: Charge) => Promise<void>;
export type TickCounts = { renewed: number; retried: number; canceled: number; skipped: number };

const MAX_FAILURES = 3;

/**
 * Advances finix subscriptions: renewals at period end, retries while
 * past_due, cancellations. chargeFn performs the provider call and — when
 * the response is already terminal — applies the outcome itself.
 * NEVER touches stripe subs. Skips subs with a pending charge.
 */
export async function runBillingTick(db: DB, chargeFn: ChargeFn): Promise<TickCounts> {
  const now = Date.now();
  const counts: TickCounts = { renewed: 0, retried: 0, canceled: 0, skipped: 0 };
  const subs = db.select().from(subscriptions).where(eq(subscriptions.provider, "finix")).all();
  for (const sub of subs) {
    if (hasPendingCharge(db, sub.id)) {
      counts.skipped += 1;
      continue;
    }
    if (sub.status === "past_due" && sub.consecutiveFailures >= MAX_FAILURES) {
      db.update(subscriptions)
        .set({ status: "canceled", updatedAt: now })
        .where(eq(subscriptions.id, sub.id))
        .run();
      counts.canceled += 1;
      continue;
    }
    if (sub.status === "active") {
      const periodEnd = sub.currentPeriodEnd;
      if (periodEnd === null || periodEnd > now) continue;
      if (sub.cancelAtPeriodEnd) {
        db.update(subscriptions)
          .set({ status: "canceled", updatedAt: now })
          .where(eq(subscriptions.id, sub.id))
          .run();
        counts.canceled += 1;
        continue;
      }
      const plan = sub.planId
        ? db.select().from(plans).where(eq(plans.id, sub.planId)).get()
        : undefined;
      if (!plan) {
        counts.skipped += 1;
        continue;
      }
      const charge = insertCharge(db, {
        subscriptionId: sub.id,
        periodStart: periodEnd,
        periodEnd: periodEnd + periodMs(plan.interval),
        amountCents: plan.priceCents,
        currency: plan.currency.toUpperCase(),
      });
      await chargeFn(db, sub, charge);
      counts.renewed += 1;
      continue;
    }
    if (sub.status === "past_due") {
      const last = db
        .select()
        .from(charges)
        .where(eq(charges.subscriptionId, sub.id))
        .orderBy(desc(charges.createdAt))
        .limit(1)
        .get();
      const plan = sub.planId
        ? db.select().from(plans).where(eq(plans.id, sub.planId)).get()
        : undefined;
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
    // non-tickable statuses (canceled, incomplete, unpaid, …) fall through silently
  }
  return counts;
}
