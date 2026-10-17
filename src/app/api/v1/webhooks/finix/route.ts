import { getDb } from "@/server/db/client";
import { handleFinixWebhook } from "@/server/modules/billing/finix";

/**
 * POST /api/v1/webhooks/finix — Finix event sink. Raw body required for
 * signature verification; 404 unless FINIX creds + FINIX_WEBHOOK_SECRET set.
 */
export async function POST(req: Request) {
  const payload = await req.text();
  const signature = req.headers.get("finix-signature");
  const result = handleFinixWebhook(getDb(), payload, signature);
  if (result.status === 404) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  if (result.status === 400) return Response.json({ error: "INVALID_SIGNATURE" }, { status: 400 });
  return Response.json({ data: { received: true } }, { status: 200 });
}
