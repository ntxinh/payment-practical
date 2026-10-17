import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { createDb } from "@/server/db/client";
import { plans } from "@/server/db/schema";
import { dbPath } from "@/server/env";
import { PLAN_DEFS } from "./plans";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) throw new Error("STRIPE_SECRET_KEY required");
const stripe = new Stripe(key);
const db = createDb(dbPath());

for (const def of PLAN_DEFS) {
  const products = await stripe.products.list({ limit: 100 });
  const product =
    products.data.find((p) => p.metadata?.slug === def.slug) ??
    (await stripe.products.create({ name: def.name, metadata: { slug: def.slug } }));

  const existing = await stripe.prices.list({ product: product.id, limit: 100 });
  const price =
    existing.data.find(
      (x) =>
        x.unit_amount === def.priceCents &&
        x.currency === def.currency &&
        x.recurring?.interval === def.interval,
    ) ??
    (await stripe.prices.create({
      product: product.id,
      unit_amount: def.priceCents,
      currency: def.currency,
      recurring: { interval: def.interval },
    }));

  db.update(plans).set({ stripePriceId: price.id }).where(eq(plans.slug, def.slug)).run();
  console.log(`${def.slug} → ${price.id}`);
}
db.$client.close();
