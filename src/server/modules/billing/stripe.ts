import "server-only";
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { ulid } from "ulidx";
import type { DB } from "@/server/db/client";
import { subscriptions, users, webhookEvents, type Plan, type User } from "@/server/db/schema";
import { appUrl } from "@/server/env";
import { BillingError } from "./errors";
import { mapSubscriptionStatus, type SubscriptionStatus } from "./subscriptions";

// process.env (not env.ts) so tests can inject keys after module load.
let client: Stripe | null | undefined;

/** Test hook: stub client, force unconfigured (null), or reset (undefined). */
export function setStripeForTests(stub: Stripe | null | undefined): void {
  client = stub;
}

/** Lazy singleton; throws STRIPE_NOT_CONFIGURED without STRIPE_SECRET_KEY. */
export function getStripe(): Stripe {
  if (client === undefined) {
    client = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
  }
  if (!client) throw new BillingError("STRIPE_NOT_CONFIGURED");
  return client;
}

export async function checkoutUrlForPlan(db: DB, user: User, plan: Plan): Promise<string> {
  if (!plan.active || !plan.stripePriceId) throw new BillingError("PLAN_NOT_FOUND");
  const stripe = getStripe();
  let customerId = user.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { userId: user.id },
    });
    customerId = customer.id;
    db.update(users).set({ stripeCustomerId: customerId }).where(eq(users.id, user.id)).run();
  }
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: plan.stripePriceId, quantity: 1 }],
    success_url: `${appUrl()}/account/billing?success=1`,
    cancel_url: `${appUrl()}/pricing`,
    client_reference_id: user.id,
    metadata: { userId: user.id },
    subscription_data: { metadata: { userId: user.id } },
  });
  if (!session.url) throw new Error("stripe returned no checkout url");
  return session.url;
}

export async function portalUrlForUser(user: User): Promise<string> {
  if (!user.stripeCustomerId) throw new BillingError("NO_STRIPE_CUSTOMER");
  const session = await getStripe().billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: `${appUrl()}/account/billing`,
  });
  return session.url;
}

function resolveUserId(db: DB, sub: Stripe.Subscription): string | undefined {
  const fromMeta = sub.metadata?.userId;
  // Verify metadata userId exists — a bad id would throw on FK and poison retries.
  if (fromMeta && db.select().from(users).where(eq(users.id, fromMeta)).get()) return fromMeta;
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
  if (!customerId) return undefined;
  return db.select().from(users).where(eq(users.stripeCustomerId, customerId)).get()?.id;
}

function upsertSubscription(db: DB, sub: Stripe.Subscription, userId: string): void {
  const item = sub.items.data[0];
  const now = Date.now();
  const row = {
    stripePriceId: item?.price.id ?? "",
    status: mapSubscriptionStatus(sub.status) satisfies SubscriptionStatus,
    currentPeriodEnd: item?.current_period_end ? item.current_period_end * 1000 : null,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    updatedAt: now,
  };
  db.insert(subscriptions)
    .values({ id: ulid(), userId, stripeSubscriptionId: sub.id, createdAt: now, ...row })
    .onConflictDoUpdate({ target: subscriptions.stripeSubscriptionId, set: row })
    .run();
}

/**
 * Applies one verified event. Checks webhook_events for the id first — replayed
 * events are IGNORED. The row is recorded only at terminal outcomes (APPLIED or
 * terminal IGNORED) so a thrown error leaves no trace and Stripe's retry
 * re-processes. Events we can't associate with a user are recorded and IGNORED
 * so Stripe stops retrying. Safe because better-sqlite3 is synchronous.
 */
export async function processBillingEvent(
  db: DB,
  stripe: Stripe,
  event: Stripe.Event,
): Promise<"APPLIED" | "IGNORED"> {
  const seen = db
    .select()
    .from(webhookEvents)
    .where(eq(webhookEvents.stripeEventId, event.id))
    .get();
  if (seen) return "IGNORED";

  const record = () => {
    db.insert(webhookEvents)
      .values({ stripeEventId: event.id, type: event.type, processedAt: Date.now() })
      .onConflictDoNothing()
      .run();
  };

  let sub: Stripe.Subscription | null = null;
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const subId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
    if (session.mode !== "subscription" || !subId) {
      record();
      return "IGNORED";
    }
    // Errors propagate unrecorded → route 500s → Stripe retries and re-processes.
    sub = await stripe.subscriptions.retrieve(subId);
  } else if (event.type.startsWith("customer.subscription.")) {
    sub = event.data.object as Stripe.Subscription;
  }
  if (!sub) {
    record();
    return "IGNORED";
  }

  const userId = resolveUserId(db, sub);
  if (!userId) {
    record();
    return "IGNORED";
  }
  upsertSubscription(db, sub, userId);
  record();
  return "APPLIED";
}

/**
 * 404 unless STRIPE_WEBHOOK_SECRET + key configured, 400 on bad signature,
 * 200 ack for handled/ignored/unknown events.
 */
export async function handleStripeWebhook(
  db: DB,
  payload: string,
  signatureHeader: string | null,
): Promise<{ status: number }> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !process.env.STRIPE_SECRET_KEY || !signatureHeader) return { status: 404 };
  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(payload, signatureHeader, secret);
  } catch {
    return { status: 400 };
  }
  await processBillingEvent(db, getStripe(), event);
  return { status: 200 };
}
