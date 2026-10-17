import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { ulid } from "ulidx";
import type { DB } from "@/server/db/client";
import {
  type Charge,
  charges,
  type Plan,
  paymentInstruments,
  type Subscription,
  subscriptions,
  type User,
  users,
} from "@/server/db/schema";
import { BillingError } from "./errors";
import {
  applyChargeOutcome,
  hasPendingCharge,
  insertCharge,
  latestPendingCharge,
  periodMs,
} from "./subscriptions";
import { recordEvent, seenEvent } from "./webhookEvents";

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

/** Single canonical parse of `timestamp=<epoch>,sig=<hex>` — shared by
 *  verify + freshness so duplicate keys can't diverge (last wins, like
 *  Object.fromEntries). Returns undefined on malformed shape. */
function parseFinixSignatureHeader(
  signatureHeader: string | null,
): { ts: string; sig: string } | undefined {
  if (!signatureHeader) return undefined;
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => kv.trim().split("=", 2) as [string, string]),
  );
  const ts = parts.timestamp;
  const sig = parts.sig;
  if (!ts || !sig || !/^\d+$/.test(ts) || !/^[0-9a-f]{64}$/i.test(sig)) return undefined;
  return { ts, sig };
}

/** Finix-Signature: `timestamp=<epoch>,sig=<hex>`; sig = HMAC-SHA256(`${ts}:${rawBody}`, secret). */
export function verifyFinixSignature(
  payload: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  const parts = parseFinixSignatureHeader(signatureHeader);
  if (!parts) return false;
  const expected = createHmac("sha256", secret).update(`${parts.ts}:${payload}`).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(parts.sig, "hex");
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

/**
 * Tokenized instrument → attached to the user's identity → subscription +
 * first charge created → transfer issued. SUCCEEDED responses settle
 * immediately (fast path); anything else waits for the webhook.
 */
export async function createFinixSubscription(
  db: DB,
  finix: Finix,
  user: User,
  plan: Plan,
  paymentInstrumentId: string,
): Promise<{ subscription: Subscription; charge: Charge }> {
  // Retry guard: a live finix sub (active/past_due, or incomplete with an
  // in-flight charge) blocks a second subscribe — regardless of newer rows
  // in any provider. Dead subs (canceled/incomplete_expired, or incomplete
  // with only failed charges) don't block retries.
  const blocking = db
    .select({ id: subscriptions.id, status: subscriptions.status })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, user.id),
        eq(subscriptions.provider, "finix"),
        inArray(subscriptions.status, ["incomplete", "active", "past_due"]),
      ),
    )
    .all();
  for (const sub of blocking) {
    if (sub.status !== "incomplete" || hasPendingCharge(db, sub.id)) {
      throw new BillingError("FINIX_SUB_EXISTS");
    }
  }
  if (!plan.active) throw new BillingError("PLAN_NOT_FOUND");
  const identityId = await ensureIdentity(db, finix, user);
  await attachInstrument(finix, identityId, paymentInstrumentId);
  const now = Date.now();
  db.insert(paymentInstruments)
    .values({
      id: ulid(),
      userId: user.id,
      finixInstrumentId: paymentInstrumentId,
      finixIdentityId: identityId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: paymentInstruments.userId,
      set: {
        finixInstrumentId: paymentInstrumentId,
        finixIdentityId: identityId,
        updatedAt: now,
      },
    })
    .run();
  const subId = ulid();
  db.insert(subscriptions)
    .values({
      id: subId,
      userId: user.id,
      provider: "finix",
      finixIdentityId: identityId,
      planId: plan.id,
      stripeSubscriptionId: null,
      stripePriceId: null,
      status: "incomplete",
      currentPeriodEnd: now + periodMs(plan.interval),
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const charge = insertCharge(db, {
    subscriptionId: subId,
    periodStart: now,
    periodEnd: now + periodMs(plan.interval),
    amountCents: plan.priceCents,
    currency: plan.currency.toUpperCase(),
  });
  const sub = db.select().from(subscriptions).where(eq(subscriptions.id, subId)).get();
  if (!sub) throw new Error("inserted subscription not found");
  await chargeForPeriod(db, finix, sub, charge);
  // Re-select: the fast path may have settled the sub (incomplete → active/…).
  const settled = db.select().from(subscriptions).where(eq(subscriptions.id, subId)).get();
  if (!settled) throw new Error("inserted subscription not found");
  return { subscription: settled, charge };
}

/** Charges one period. Terminal transfer states apply immediately (and mark
 *  the passed charge object so callers can redirect on charge.status);
 *  pending relies on the webhook. Errors propagate (caller 500s → retry). */
export async function chargeForPeriod(
  db: DB,
  finix: Finix,
  sub: Subscription,
  charge: Charge,
): Promise<void> {
  const instrument = db
    .select()
    .from(paymentInstruments)
    .where(eq(paymentInstruments.userId, sub.userId))
    .get();
  if (!instrument) {
    // Same wedging rule as a thrown transfer: no webhook will ever settle.
    applyChargeOutcome(db, charge, "failed");
    charge.status = "failed";
    throw new BillingError("FINIX_NO_INSTRUMENT");
  }
  let t: FinixTransfer;
  try {
    t = await postTransfer(finix, {
      amount: charge.amountCents,
      currency: charge.currency,
      source: instrument.finixInstrumentId,
      merchant_id: finix.merchantId,
      idempotency_id: charge.id,
      tags: { chargeId: charge.id, subscriptionId: sub.id },
    });
  } catch (e) {
    // A thrown transfer leaves no webhook to settle the charge — mark it
    // failed so the sub isn't wedged pending forever, then propagate.
    applyChargeOutcome(db, charge, "failed");
    charge.status = "failed";
    throw e;
  }
  charge.finixTransferId = t.id ?? null;
  db.update(charges)
    .set({ finixTransferId: charge.finixTransferId, updatedAt: Date.now() })
    .where(eq(charges.id, charge.id))
    .run();
  const outcome = transferOutcome(t.state);
  if (outcome !== "pending") {
    applyChargeOutcome(db, charge, outcome);
    charge.status = outcome;
  }
}

export type FinixEvent = { id?: string; type?: string; entity?: string; data?: FinixTransfer };

/** Stable across Finix delivery retries: event id, else transfer id+state+updated_at. */
function finixEventKey(event: FinixEvent, t: FinixTransfer): string {
  return event.id ?? `transfer:${t.id}:${t.state}:${t.updated_at ?? ""}`;
}

/** Transfer events only, deduped on (key, 'finix'); terminal outcomes applied.
 *  Non-pending charges are never re-applied (a settled charge stays settled). */
export function processFinixEvent(db: DB, event: FinixEvent): "APPLIED" | "IGNORED" {
  const t = event.data ?? {};
  if (event.entity !== "transfer" || !t.id) return "IGNORED";
  const key = finixEventKey(event, t);
  if (seenEvent(db, key, "finix")) return "IGNORED";

  const chargeId = t.tags?.chargeId;
  const charge =
    (chargeId ? db.select().from(charges).where(eq(charges.id, chargeId)).get() : undefined) ??
    (t.tags?.subscriptionId ? latestPendingCharge(db, t.tags.subscriptionId) : undefined);
  if (charge?.status !== "pending") {
    recordEvent(db, key, event.type ?? "transfer", "finix");
    return "IGNORED";
  }
  const outcome = transferOutcome(t.state);
  if (outcome === "pending") {
    recordEvent(db, key, event.type ?? "transfer", "finix");
    return "IGNORED";
  }
  db.update(charges)
    .set({ finixTransferId: t.id, updatedAt: Date.now() })
    .where(eq(charges.id, charge.id))
    .run();
  applyChargeOutcome(db, charge, outcome);
  recordEvent(db, key, event.type ?? "transfer", "finix");
  return "APPLIED";
}

const MAX_SIG_SKEW_S = 300;

/** 404 unconfigured/missing header; 400 bad sig or stale timestamp (>300s skew); 200 processed. */
export function handleFinixWebhook(
  db: DB,
  payload: string,
  signatureHeader: string | null,
): { status: number } {
  const secret = process.env.FINIX_WEBHOOK_SECRET;
  if (!secret || !finixConfigured() || !signatureHeader) return { status: 404 };
  // Same `parts` object feeds verify + freshness — the ts under the HMAC is the ts we gate on.
  const parts = parseFinixSignatureHeader(signatureHeader);
  if (!parts || !verifyFinixSignature(payload, signatureHeader, secret)) return { status: 400 };
  if (Math.abs(Date.now() / 1000 - Number(parts.ts)) > MAX_SIG_SKEW_S) {
    return { status: 400 };
  }
  const event = JSON.parse(payload) as FinixEvent;
  processFinixEvent(db, event);
  return { status: 200 };
}
