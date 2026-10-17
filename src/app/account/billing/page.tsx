import Link from "next/link";
import { redirect } from "next/navigation";
import { finixCancel, manageBilling } from "@/features/billing/actions";
import { getCurrentUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import {
  getFinixSubscription,
  getLatestSubscription,
  isActive,
  mapSubscriptionStatus,
} from "@/server/modules/billing/subscriptions";

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string; pending?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const params = await searchParams;
  const sub = getLatestSubscription(getDb(), user.id);
  const finixSub = getFinixSubscription(getDb(), user.id);
  return (
    <>
      <h1>Billing</h1>
      {params.success && <p>Subscription activated.</p>}
      {params.pending && <p>Payment processing — status updates shortly.</p>}
      {params.error && <p className="error">{params.error}</p>}
      {sub ? (
        <>
          <p>
            Status: <strong>{sub.status}</strong>
            {isActive(mapSubscriptionStatus(sub.status)) ? "" : " (no access)"}
            {" · "}Provider: {sub.provider}
          </p>
          {sub.provider === "finix" && sub.currentPeriodEnd && (
            <p>Current period ends {new Date(sub.currentPeriodEnd).toLocaleDateString()}.</p>
          )}
        </>
      ) : (
        <p>
          No subscription. <Link href="/pricing">Pick a plan</Link>
        </p>
      )}
      {finixSub ? (
        <>
          <p>
            Finix subscription: <strong>{finixSub.status}</strong>
            {finixSub.currentPeriodEnd &&
              ` · period ends ${new Date(finixSub.currentPeriodEnd).toLocaleDateString()}`}
          </p>
          {finixSub.cancelAtPeriodEnd ? (
            <p>Cancels at period end.</p>
          ) : (
            <form action={finixCancel}>
              <button type="submit">Cancel at period end</button>
            </form>
          )}
        </>
      ) : sub?.provider !== "finix" ? (
        <form action={manageBilling}>
          <button type="submit">Manage billing</button>
        </form>
      ) : null}
    </>
  );
}
