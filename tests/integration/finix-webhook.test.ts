import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { charges, plans, subscriptions, users } from "@/server/db/schema";
import { insertCharge, periodMs } from "@/server/modules/billing/subscriptions";
import { makeTestDb } from "../helpers/db";

const NOW = Date.now();
const SECRET = "fwhsec_test";

vi.mock("@/server/db/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/db/client")>();
  return { ...mod, getDb: () => current };
});
let current: ReturnType<typeof makeTestDb>;
let POST: (req: Request) => Promise<Response>;

// Finix-Signature: `timestamp=<epoch>,sig=<hmac-sha256(`${ts}:${body}`)>`;
// ts must be within the 300s freshness window.
const sign = (payload: string, ts = Math.floor(Date.now() / 1000)): string =>
  `timestamp=${ts},sig=${createHmac("sha256", SECRET).update(`${ts}:${payload}`).digest("hex")}`;

const post = (body: string, sig: string | null) =>
  POST(
    new Request("http://x/api/v1/webhooks/finix", {
      method: "POST",
      headers: sig ? { "finix-signature": sig } : {},
      body,
    }),
  );

describe("POST /api/v1/webhooks/finix", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("FINIX_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("FINIX_USERNAME", "u");
    vi.stubEnv("FINIX_PASSWORD", "p");
    vi.stubEnv("FINIX_MERCHANT_ID", "MU_x");
    vi.stubEnv("FINIX_APPLICATION_ID", "AP_x");
    current = makeTestDb("finix-wh-route");
    // Dynamic import required: vi.resetModules() above forces a fresh module
    // registry so the route picks up the mocked getDb per test.
    POST = (await import("@/app/api/v1/webhooks/finix/route")).POST;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    current?.$client.close();
  });

  it("400 on bad signature", async () => {
    const res = await post("{}", "timestamp=1,sig=deadbeef");
    expect(res.status).toBe(400);
  });

  it("404 when webhook secret unset", async () => {
    vi.stubEnv("FINIX_WEBHOOK_SECRET", "");
    const res = await post("{}", "any");
    expect(res.status).toBe(404);
  });

  it("200 + settles a pending charge on a valid transfer event", async () => {
    current.insert(users).values({ id: "u1", email: "a@b.c", createdAt: NOW }).run();
    current
      .insert(plans)
      .values({
        id: "plan_basic",
        slug: "basic",
        name: "Basic",
        priceCents: 999,
        currency: "usd",
        interval: "month",
        createdAt: NOW,
      })
      .run();
    current
      .insert(subscriptions)
      .values({
        id: "s1",
        userId: "u1",
        provider: "finix",
        planId: "plan_basic",
        status: "incomplete",
        currentPeriodEnd: NOW + periodMs("month"),
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    const charge = insertCharge(current, {
      subscriptionId: "s1",
      periodStart: NOW,
      periodEnd: NOW + periodMs("month"),
      amountCents: 999,
      currency: "USD",
    });
    const payload = JSON.stringify({
      id: "EV_rt",
      type: "entity",
      entity: "transfer",
      data: { id: "TR_9", state: "SUCCEEDED", tags: { chargeId: charge.id } },
    });
    const res = await post(payload, sign(payload));
    expect(res.status).toBe(200);
    expect(current.select().from(charges).where(eq(charges.id, charge.id)).get()).toMatchObject({
      status: "paid",
      finixTransferId: "TR_9",
    });
    expect(
      current.select().from(subscriptions).where(eq(subscriptions.id, "s1")).get()?.status,
    ).toBe("active");
  });
});
