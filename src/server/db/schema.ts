import "server-only";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  stripeCustomerId: text("stripe_customer_id"),
  finixIdentityId: text("finix_identity_id"),
  createdAt: integer("created_at").notNull(),
});

export const plans = sqliteTable("plans", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  priceCents: integer("price_cents").notNull(),
  currency: text("currency").notNull(),
  interval: text("interval").notNull(), // "month" | "year"
  stripePriceId: text("stripe_price_id"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull(),
});

export const subscriptions = sqliteTable("subscriptions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  provider: text("provider").notNull().default("stripe"), // "stripe" | "finix"
  stripeSubscriptionId: text("stripe_subscription_id").unique(), // null on finix rows
  stripePriceId: text("stripe_price_id"),
  finixIdentityId: text("finix_identity_id"),
  planId: text("plan_id").references(() => plans.id), // finix rows need price+interval
  status: text("status").notNull(),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  currentPeriodEnd: integer("current_period_end"),
  cancelAtPeriodEnd: integer("cancel_at_period_end", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// One card per user (dev scope) — re-adding a card upserts on user_id.
export const paymentInstruments = sqliteTable("payment_instruments", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id),
  finixInstrumentId: text("finix_instrument_id").notNull().unique(),
  finixIdentityId: text("finix_identity_id").notNull(),
  last4: text("last4"),
  brand: text("brand"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// charges.id doubles as the Finix Transfer idempotency_id.
export const charges = sqliteTable("charges", {
  id: text("id").primaryKey(),
  subscriptionId: text("subscription_id")
    .notNull()
    .references(() => subscriptions.id),
  periodStart: integer("period_start").notNull(),
  periodEnd: integer("period_end").notNull(),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull(),
  status: text("status").notNull(), // ChargeStatus
  finixTransferId: text("finix_transfer_id"),
  attemptNo: integer("attempt_no").notNull().default(1),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const webhookEvents = sqliteTable(
  "webhook_events",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    provider: text("provider").notNull().default("stripe"), // "stripe" | "finix"
    type: text("type").notNull(),
    processedAt: integer("processed_at").notNull(),
  },
  (t) => [uniqueIndex("uq_webhook_events_event_provider").on(t.eventId, t.provider)],
);

export type User = typeof users.$inferSelect;
export type Plan = typeof plans.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type PaymentInstrument = typeof paymentInstruments.$inferSelect;
export type Charge = typeof charges.$inferSelect;
export type ChargeStatus = "pending" | "paid" | "failed";
export type WebhookEvent = typeof webhookEvents.$inferSelect;
