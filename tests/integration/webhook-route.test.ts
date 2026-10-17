import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { users } from "@/server/db/schema";
import { setStripeForTests } from "@/server/modules/billing/stripe";
import { makeTestDb } from "../helpers/db";

const WHSEC = "whsec_test";
const stripe = new Stripe("sk_test_unused");

vi.mock("@/server/db/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/db/client")>();
  return { ...mod, getDb: () => current };
});
let current: ReturnType<typeof makeTestDb>;
let POST: typeof import("@/app/api/v1/webhooks/stripe/route").POST;

const post = (body: string, sig: string | null) =>
  POST(
    new Request("http://x/api/v1/webhooks/stripe", {
      method: "POST",
      headers: sig ? { "stripe-signature": sig } : {},
      body,
    }),
  );

describe("POST /api/v1/webhooks/stripe", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_unused");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", WHSEC);
    current = makeTestDb("webhook");
    current
      .insert(users)
      .values({ id: "u1", email: "a@b.c", stripeCustomerId: "cus_1", createdAt: Date.now() })
      .run();
    setStripeForTests(stripe);
    // Dynamic import required: vi.resetModules() above forces a fresh module
    // registry so the route picks up the mocked getDb per test.
    POST = (await import("@/app/api/v1/webhooks/stripe/route")).POST;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    setStripeForTests(undefined);
    current?.$client.close();
  });

  it("400 on bad signature", async () => {
    const res = await post("{}", "bad");
    expect(res.status).toBe(400);
  });

  it("404 when webhook secret unset", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    const res = await post("{}", "any");
    expect(res.status).toBe(404);
  });

  it("200 for a valid customer.subscription.updated (resolved via customer id)", async () => {
    const payload = JSON.stringify({
      id: "evt_rt1",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_rt",
          status: "active",
          customer: "cus_1",
          metadata: {},
          cancel_at_period_end: false,
          items: { data: [{ price: { id: "price_1" }, current_period_end: 1_800_000_000 }] },
        },
      },
    });
    const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC });
    const res = await post(payload, sig);
    expect(res.status).toBe(200);
  });
});
