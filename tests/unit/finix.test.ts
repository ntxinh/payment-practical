import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachInstrument,
  type Finix,
  finixConfigured,
  getFinix,
  postTransfer,
  setFinixForTests,
  transferOutcome,
  verifyFinixSignature,
} from "@/server/modules/billing/finix";

describe("transferOutcome", () => {
  it.each([
    ["SUCCEEDED", "paid"],
    ["FAILED", "failed"],
    ["CANCELED", "failed"],
    ["PENDING", "pending"],
    ["UPDATE_TRANSFER", "pending"],
    [null, "pending"],
    [undefined, "pending"],
  ] as const)("%s → %s", (state, outcome) => expect(transferOutcome(state)).toBe(outcome));
});

describe("verifyFinixSignature", () => {
  const secret = "whsec_test";
  const payload = JSON.stringify({ id: "EVevt", type: "transfer.succeeded" });
  const ts = "1700000000";
  const sig = createHmac("sha256", secret).update(`${ts}:${payload}`).digest("hex");

  it("accepts a correctly forged header", () => {
    expect(verifyFinixSignature(payload, `timestamp=${ts},sig=${sig}`, secret)).toBe(true);
  });

  it("rejects a tampered signature", () => {
    const bad = `${sig.slice(0, 62)}00`;
    expect(verifyFinixSignature(payload, `timestamp=${ts},sig=${bad}`, secret)).toBe(false);
  });

  it("rejects a signature over a different payload", () => {
    expect(verifyFinixSignature(`${payload}x`, `timestamp=${ts},sig=${sig}`, secret)).toBe(false);
  });

  it.each([
    [null],
    [""],
    ["not-a-header"],
    ["timestamp=abc,sig=abc"],
    [`timestamp=${ts}`],
    [`sig=${sig}`],
    [`timestamp=${ts},sig=${sig}ff`], // sig not 64 hex → malformed
  ])("rejects malformed/tampered header %j", (header) => {
    expect(verifyFinixSignature(payload, header, secret)).toBe(false);
  });
});

function stubFinix(impl: (path: string, init: RequestInit) => unknown): Finix {
  return {
    fetchFn: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify(impl(String(input), init ?? {})), { status: 200 }),
      ),
    ) as unknown as typeof fetch,
    base: "https://finix.sandbox-payments-api.com",
    auth: "Basic dXNlcjpwYXNz",
    merchantId: "MUxxx",
    applicationId: "APxxx",
  };
}

describe("postTransfer", () => {
  it("POSTs /transfers with uppercased currency and caller-supplied merchant_id", async () => {
    const finix = stubFinix((path, init) => {
      expect(path).toBe("https://finix.sandbox-payments-api.com/transfers");
      expect(init.method).toBe("POST");
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({
        amount: 1200,
        currency: "USD",
        source: "PIxxx",
        merchant_id: "MUcaller",
        idempotency_id: "idem-1",
      });
      return { id: "TRxxx", state: "SUCCEEDED" };
    });
    const res = await postTransfer(finix, {
      amount: 1200,
      currency: "usd",
      source: "PIxxx",
      merchant_id: "MUcaller",
      idempotency_id: "idem-1",
    });
    expect(res.id).toBe("TRxxx");
  });
});

describe("attachInstrument", () => {
  it("PUTs the instrument with the identity", async () => {
    const finix = stubFinix((path, init) => {
      expect(path).toBe("https://finix.sandbox-payments-api.com/payment_instruments/PI%2Fenc");
      expect(init.method).toBe("PUT");
      expect(JSON.parse(String(init.body))).toMatchObject({ identity: "IDxxx" });
      return { id: "PI/enc" };
    });
    await expect(attachInstrument(finix, "IDxxx", "PI/enc")).resolves.toBeUndefined();
  });

  it("maps Finix rejection to FINIX_INSTRUMENT_INVALID", async () => {
    const failing: Finix = {
      ...stubFinix(() => ({})),
      fetchFn: (async () => new Response("bad", { status: 400 })) as unknown as typeof fetch,
    };
    await expect(attachInstrument(failing, "IDxxx", "PIxxx")).rejects.toMatchObject({
      name: "BillingError",
      code: "FINIX_INSTRUMENT_INVALID",
    });
  });
});

describe("getFinix", () => {
  afterEach(() => setFinixForTests(undefined));

  it("throws FINIX_NOT_CONFIGURED without creds", () => {
    setFinixForTests(null);
    expect(finixConfigured()).toBe(false);
    expect(() => getFinix()).toThrowError(
      expect.objectContaining({ code: "FINIX_NOT_CONFIGURED" }),
    );
  });
});
