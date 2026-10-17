import "server-only";
import { eq } from "drizzle-orm";
import type { DB } from "@/server/db/client";
import { plans, type Plan } from "@/server/db/schema";

export function getActivePlans(db: DB): Plan[] {
  return db.select().from(plans).where(eq(plans.active, true)).all();
}

export function getPlanById(db: DB, id: string): Plan | undefined {
  return db.select().from(plans).where(eq(plans.id, id)).get();
}
