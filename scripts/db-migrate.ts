import { createDb, migrateDb } from "@/server/db/client";
import { dbPath } from "@/server/env";

const db = createDb(dbPath());
migrateDb(db);
db.$client.close();
console.log("migrated", dbPath());
