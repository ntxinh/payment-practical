import Link from "next/link";
import { redirect } from "next/navigation";
import { manageBilling } from "@/features/billing/actions";
import { getCurrentUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import {
  getLatestSubscription,
  isActive,
  mapSubscriptionStatus,
} from "@/server/modules/billing/subscriptions";

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const params = await searchParams;
  const sub = getLatestSubscription(getDb(), user.id);
  return (
    <>
      <h1>Billing</h1>
      {params.success && <p>Subscription activated.</p>}
      {params.error && <p className="error">{params.error}</p>}
      {sub ? (
        <p>
          Status: <strong>{sub.status}</strong>
          {isActive(mapSubscriptionStatus(sub.status)) ? "" : " (no access)"}
        </p>
      ) : (
        <p>
          No subscription. <Link href="/pricing">Pick a plan</Link>
        </p>
      )}
      <form action={manageBilling}>
        <button type="submit">Manage billing</button>
      </form>
    </>
  );
}
