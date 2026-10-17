import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/server/db/client";
import { sessionSecret } from "@/server/env";
import { chargeForPeriod, getFinix } from "@/server/modules/billing/finix";
import { runBillingTick } from "@/server/modules/billing/tick";

/**
 * POST /api/v1/billing-tick — dev-gated renewal/cancel/dunning driver for
 * finix subscriptions. Requires header `x-billing-secret: $SESSION_SECRET`,
 * else 404. Stand-in for cron; see docs/operations/local-development.md.
 */
export async function POST(req: Request) {
  const secret = sessionSecret();
  const got = req.headers.get("x-billing-secret") ?? "";
  const ok = got.length === secret.length && timingSafeEqual(Buffer.from(got), Buffer.from(secret));
  if (!ok) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  const counts = await runBillingTick(getDb(), (d, s, c) => chargeForPeriod(d, getFinix(), s, c));
  return Response.json({ data: counts }, { status: 200 });
}
