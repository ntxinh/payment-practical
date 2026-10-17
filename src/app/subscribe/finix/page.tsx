import { redirect } from "next/navigation";
import { FinixForm } from "@/features/billing/finix-form";
import { getCurrentUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { getPlanById } from "@/server/modules/billing/plans";

export default async function FinixSubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { plan: planId } = await searchParams;
  const plan = getPlanById(getDb(), planId ?? "");
  if (!plan) redirect("/pricing?error=PLAN_NOT_FOUND");
  const applicationId = process.env.FINIX_APPLICATION_ID;
  if (!applicationId) redirect("/pricing?error=FINIX_NOT_CONFIGURED");
  return (
    <>
      <h1>Pay with Finix — {plan.name}</h1>
      <p>
        ${(plan.priceCents / 100).toFixed(2)}/{plan.interval}
      </p>
      <FinixForm
        applicationId={applicationId}
        environment={(process.env.FINIX_BASE_URL ?? "").includes("live") ? "prod" : "sandbox"}
        planId={plan.id}
      />
    </>
  );
}
