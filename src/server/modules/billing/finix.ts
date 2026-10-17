import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DB } from "@/server/db/client";
import { type User, users } from "@/server/db/schema";
import { BillingError } from "./errors";

const DEFAULT_BASE = "https://finix.sandbox-payments-api.com";
const FINIX_VERSION = "2022-02-01";
const TIMEOUT_MS = 15_000;

export type Finix = {
  fetchFn: typeof fetch;
  base: string;
  auth: string;
  merchantId: string;
  applicationId: string;
};

// process.env (not env.ts) so tests can inject creds after module load.
let client: Finix | null | undefined;

/** Test hook: stub client, force unconfigured (null), or reset (undefined). */
export function setFinixForTests(stub: Finix | null | undefined): void {
  client = stub;
}

export function finixConfigured(): boolean {
  return !!(
    process.env.FINIX_USERNAME &&
    process.env.FINIX_PASSWORD &&
    process.env.FINIX_MERCHANT_ID &&
    process.env.FINIX_APPLICATION_ID
  );
}

/** Lazy singleton; throws FINIX_NOT_CONFIGURED without creds. */
export function getFinix(): Finix {
  if (client === undefined) {
    const {
      FINIX_USERNAME: u,
      FINIX_PASSWORD: p,
      FINIX_MERCHANT_ID: m,
      FINIX_APPLICATION_ID: a,
    } = process.env;
    client =
      u && p && m && a
        ? {
            fetchFn: fetch,
            base: process.env.FINIX_BASE_URL ?? DEFAULT_BASE,
            auth: `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`,
            merchantId: m,
            applicationId: a,
          }
        : null;
  }
  if (!client) throw new BillingError("FINIX_NOT_CONFIGURED");
  return client;
}

export async function finixRequest(
  finix: Finix,
  method: string,
  path: string,
  body?: unknown,
  // biome-ignore lint/suspicious/noExplicitAny: Finix payloads are loosely typed JSON
): Promise<any> {
  const res = await finix.fetchFn(`${finix.base}${path}`, {
    method,
    headers: {
      Authorization: finix.auth,
      "Finix-Version": FINIX_VERSION,
      "Content-Type": "application/vnd.json+api",
      Accept: "application/vnd.json+api",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`finix ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

export type FinixTransfer = {
  id?: string;
  state?: string;
  currency?: string;
  amount?: number;
  entity_id?: string;
  checkout_form_id?: string;
  tags?: Record<string, string>;
  updated_at?: string;
};

/** SUCCEEDED is the only capture; FAILED/CANCELED terminal; else still settling. */
export function transferOutcome(state: string | null | undefined): "paid" | "failed" | "pending" {
  if (state === "SUCCEEDED") return "paid";
  if (state === "FAILED" || state === "CANCELED") return "failed";
  return "pending";
}

/** Finix-Signature: `timestamp=<epoch>,sig=<hex>`; sig = HMAC-SHA256(`${ts}:${rawBody}`, secret). */
export function verifyFinixSignature(
  payload: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => kv.trim().split("=", 2) as [string, string]),
  );
  const ts = parts.timestamp;
  const sig = parts.sig;
  if (!ts || !sig || !/^\d+$/.test(ts) || !/^[0-9a-f]{64}$/i.test(sig)) return false;
  const expected = createHmac("sha256", secret).update(`${ts}:${payload}`).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(sig, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** users.finix_identity_id get-or-create. */
export async function ensureIdentity(db: DB, finix: Finix, user: User): Promise<string> {
  if (user.finixIdentityId) return user.finixIdentityId;
  const identity = await finixRequest(finix, "POST", "/identities", {
    // Finix convention: application-scoped identity with an entity block; sandbox accepts PERSONAL.
    type: "PERSONAL",
    entity: { email: user.email },
  });
  const id = identity.id as string;
  db.update(users).set({ finixIdentityId: id }).where(eq(users.id, user.id)).run();
  return id;
}

/** Attaches a tokenized PI to the identity — throws FINIX_INSTRUMENT_INVALID on Finix rejection. */
export async function attachInstrument(
  finix: Finix,
  identityId: string,
  instrumentId: string,
): Promise<void> {
  try {
    await finixRequest(finix, "PUT", `/payment_instruments/${encodeURIComponent(instrumentId)}`, {
      type: "PAYMENT_CARD",
      identity: identityId,
    });
  } catch {
    throw new BillingError("FINIX_INSTRUMENT_INVALID");
  }
}

/** POSTs /transfers; merchant_id comes from the caller (finix.merchantId). */
export async function postTransfer(
  finix: Finix,
  body: {
    amount: number;
    currency: string;
    source: string;
    merchant_id: string;
    idempotency_id: string;
    tags?: Record<string, string>;
  },
): Promise<FinixTransfer> {
  return finixRequest(finix, "POST", "/transfers", {
    ...body,
    currency: body.currency.toUpperCase(),
  });
}
