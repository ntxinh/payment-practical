import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { DB } from "@/server/db/client";
import { subscriptions, users } from "@/server/db/schema";
import { makeTestDb } from "../helpers/db";

describe("db layer", () => {
  let db: DB;
  afterEach(() => db?.$client.close());
  it("migrates cleanly and enforces FK + unique email", () => {
    db = makeTestDb("fk");
    const now = Date.now();
    db.insert(users).values({ id: "u1", email: "a@b.c", createdAt: now }).run();
    expect(() =>
      db.insert(users).values({ id: "u2", email: "a@b.c", createdAt: now }).run(),
    ).toThrow();
    expect(() =>
      db
        .insert(subscriptions)
        .values({
          id: "s1",
          userId: "ghost",
          stripeSubscriptionId: "sub_1",
          stripePriceId: "p",
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .run(),
    ).toThrow(); // FK violation
  });

  it("schema queries round-trip via db.query", async () => {
    db = makeTestDb("query");
    db.insert(users).values({ id: "u1", email: "q@b.c", createdAt: Date.now() }).run();
    const row = await db.query.users.findFirst({ where: eq(users.email, "q@b.c") });
    expect(row?.id).toBe("u1");
  });
});
