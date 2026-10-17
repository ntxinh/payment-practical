import { redirect } from "next/navigation";
import { subscribe } from "@/features/billing/actions";
import { getCurrentUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { getActivePlans } from "@/server/modules/billing/plans";

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { error } = await searchParams;
  const plans = getActivePlans(getDb());
  return (
    <>
      <h1>Plans</h1>
      {error && <p className="error">{error}</p>}
      <div className="plans">
        {plans.map((p) => (
          <div className="plan" key={p.id}>
            <h2>{p.name}</h2>
            <p>
              ${(p.priceCents / 100).toFixed(2)}/{p.interval}
            </p>
            {p.stripePriceId ? (
              <form action={subscribe}>
                <input type="hidden" name="planId" value={p.id} />
                <button type="submit">Subscribe</button>
              </form>
            ) : (
              <p>Unavailable — run make stripe-seed</p>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
