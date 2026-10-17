import { ulid } from "ulidx";
import { createDb, migrateDb } from "@/server/db/client";
import { plans } from "@/server/db/schema";
import { dbPath } from "@/server/env";
import { PLAN_DEFS } from "./plans";

const db = createDb(dbPath());
migrateDb(db);
const now = Date.now();
for (const p of PLAN_DEFS) {
  db.insert(plans)
    .values({ id: ulid(), ...p, createdAt: now })
    .onConflictDoNothing({ target: plans.slug })
    .run();
}
db.$client.close();
console.log("seeded", PLAN_DEFS.length, "plans");
