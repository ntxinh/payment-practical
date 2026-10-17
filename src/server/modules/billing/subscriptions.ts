import "server-only";
import { desc, eq } from "drizzle-orm";
import type { DB } from "@/server/db/client";
import { subscriptions, type Subscription } from "@/server/db/schema";

export type SubscriptionStatus =
  | "active" | "trialing" | "past_due" | "canceled" | "paused"
  | "incomplete" | "incomplete_expired" | "unpaid";

const KNOWN: Record<SubscriptionStatus, true> = {
  active: true, trialing: true, past_due: true, canceled: true, paused: true,
  incomplete: true, incomplete_expired: true, unpaid: true,
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
    .orderBy(desc(subscriptions.updatedAt))
    .limit(1)
    .get();
}
