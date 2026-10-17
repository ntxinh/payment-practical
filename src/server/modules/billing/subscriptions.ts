import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { ulid } from "ulidx";
import type { DB } from "@/server/db/client";
import {
  type Charge,
  type ChargeStatus,
  charges,
  type Subscription,
  subscriptions,
} from "@/server/db/schema";

export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "paused"
  | "incomplete"
  | "incomplete_expired"
  | "unpaid";

const KNOWN: Record<SubscriptionStatus, true> = {
  active: true,
  trialing: true,
  past_due: true,
  canceled: true,
  paused: true,
  incomplete: true,
  incomplete_expired: true,
  unpaid: true,
};

/** Unknown/future Stripe statuses map to unpaid — never grant access on ambiguity. */
export function mapSubscriptionStatus(status: string): SubscriptionStatus {
  return Object.hasOwn(KNOWN, status) ? (status as SubscriptionStatus) : "unpaid";
}

export function isActive(status: SubscriptionStatus): boolean {
  return status === "active" || status === "trialing";
}

export function getLatestSubscription(db: DB, userId: string): Subscription | undefined {
  return db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .orderBy(desc(subscriptions.updatedAt), desc(subscriptions.id))
    .limit(1)
    .get();
}

/** Latest finix sub in a live status — immune to newer cross-provider rows
 *  shadowing it (the getLatestSubscription pitfall). */
export function getFinixSubscription(db: DB, userId: string): Subscription | undefined {
  return db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.provider, "finix"),
        inArray(subscriptions.status, ["incomplete", "active", "past_due"]),
      ),
    )
    .orderBy(desc(subscriptions.updatedAt), desc(subscriptions.id))
    .limit(1)
    .get();
}

const DAY_MS = 86_400_000;

/** Approximate: month → 30d, year → 365d, unknown intervals → 30d. */
export function periodMs(interval: string): number {
  if (interval === "year") return 365 * DAY_MS;
  return 30 * DAY_MS;
}

export type NewCharge = {
  subscriptionId: string;
  periodStart: number;
  periodEnd: number;
  amountCents: number;
  currency: string;
  attemptNo?: number;
};

/** Inserts a pending charge ledger row; id doubles as the Finix idempotency key. */
export function insertCharge(db: DB, c: NewCharge): Charge {
  const now = Date.now();
  const row: typeof charges.$inferInsert = {
    id: ulid(),
    subscriptionId: c.subscriptionId,
    periodStart: c.periodStart,
    periodEnd: c.periodEnd,
    amountCents: c.amountCents,
    currency: c.currency,
    attemptNo: c.attemptNo ?? 1,
    finixTransferId: null,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
  db.insert(charges).values(row).run();
  return row as Charge;
}

export function hasPendingCharge(db: DB, subscriptionId: string): boolean {
  return (
    db
      .select({ id: charges.id })
      .from(charges)
      .where(and(eq(charges.subscriptionId, subscriptionId), eq(charges.status, "pending")))
      .get() !== undefined
  );
}

export function latestPendingCharge(db: DB, subscriptionId: string): Charge | undefined {
  return db
    .select()
    .from(charges)
    .where(and(eq(charges.subscriptionId, subscriptionId), eq(charges.status, "pending")))
    .orderBy(desc(charges.createdAt), desc(charges.id))
    .limit(1)
    .get();
}

export const MAX_FAILURES = 3;

/** Applies a settled charge outcome to the charge + its subscription.
 *  paid → active, periodEnd = charge.periodEnd, failures reset.
 *  failed on incomplete (first charge) → incomplete_expired; otherwise
 *  past_due + failures++, or canceled once failures hit MAX_FAILURES. */
export function applyChargeOutcome(db: DB, charge: Charge, outcome: ChargeStatus): void {
  const now = Date.now();
  if (outcome === "pending") return;
  db.update(charges)
    .set({ status: outcome, updatedAt: now })
    .where(eq(charges.id, charge.id))
    .run();
  const sub = db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, charge.subscriptionId))
    .get();
  if (!sub) return;
  if (outcome === "paid") {
    db.update(subscriptions)
      .set({
        status: "active",
        currentPeriodEnd: charge.periodEnd,
        consecutiveFailures: 0,
        updatedAt: now,
      })
      .where(eq(subscriptions.id, sub.id))
      .run();
    return;
  }
  const failures = sub.consecutiveFailures + 1;
  const status =
    sub.status === "incomplete"
      ? "incomplete_expired"
      : failures >= MAX_FAILURES
        ? "canceled"
        : "past_due";
  db.update(subscriptions)
    .set({ status, consecutiveFailures: failures, updatedAt: now })
    .where(eq(subscriptions.id, sub.id))
    .run();
}
