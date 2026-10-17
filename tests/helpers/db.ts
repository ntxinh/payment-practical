import { createDb, migrateDb } from "@/server/db/client";

/** Fresh migrated sqlite under tests/.tmp/<name>.db. Caller closes $client. */
export function makeTestDb(name: string) {
  const db = createDb(
    `./tests/.tmp/${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  migrateDb(db);
  return db;
}
