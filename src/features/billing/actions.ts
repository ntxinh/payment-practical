"use server";

import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { BillingError } from "@/server/modules/billing/errors";
import { getPlanById } from "@/server/modules/billing/plans";
import { checkoutUrlForPlan, portalUrlForUser } from "@/server/modules/billing/stripe";

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
