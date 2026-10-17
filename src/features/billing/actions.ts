"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { subscriptions } from "@/server/db/schema";
import { BillingError } from "@/server/modules/billing/errors";
import { createFinixSubscription, getFinix } from "@/server/modules/billing/finix";
import { getPlanById } from "@/server/modules/billing/plans";
import { checkoutUrlForPlan, portalUrlForUser } from "@/server/modules/billing/stripe";
import { getFinixSubscription } from "@/server/modules/billing/subscriptions";

export async function subscribe(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const plan = getPlanById(getDb(), String(formData.get("planId") ?? ""));
  if (!plan) redirect("/pricing?error=PLAN_NOT_FOUND");
  let url: string;
  try {
    url = await checkoutUrlForPlan(getDb(), user, plan);
  } catch (e) {
    if (e instanceof BillingError) redirect(`/pricing?error=${e.code}`);
    throw e;
  }
  redirect(url);
}

export async function manageBilling(): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  let url: string;
  try {
    url = await portalUrlForUser(user);
  } catch (e) {
    if (e instanceof BillingError) redirect(`/account/billing?error=${e.code}`);
    throw e;
  }
  redirect(url);
}

export async function finixSubscribe(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const plan = getPlanById(getDb(), String(formData.get("planId") ?? ""));
  if (!plan) redirect("/pricing?error=PLAN_NOT_FOUND");
  const instrumentId = String(formData.get("paymentInstrumentId") ?? "");
  if (!instrumentId.startsWith("PI")) redirect("/pricing?error=FINIX_INSTRUMENT_INVALID");
  let chargeStatus: string;
  try {
    const { charge } = await createFinixSubscription(getDb(), getFinix(), user, plan, instrumentId);
    chargeStatus = charge.status;
  } catch (e) {
    if (e instanceof BillingError) redirect(`/pricing?error=${e.code}`);
    throw e;
  }
  // A failed first charge is already terminal (incomplete_expired) — send
  // the user to an error, not the "still processing" notice.
  const q =
    chargeStatus === "paid"
      ? "success=1"
      : chargeStatus === "failed"
        ? "error=CHARGE_FAILED"
        : "pending=1";
  redirect(`/account/billing?${q}`);
}

export async function finixCancel(): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const sub = getFinixSubscription(getDb(), user.id);
  if (sub) {
    getDb()
      .update(subscriptions)
      .set({ cancelAtPeriodEnd: true, updatedAt: Date.now() })
      .where(eq(subscriptions.id, sub.id))
      .run();
  }
  redirect("/account/billing");
}
