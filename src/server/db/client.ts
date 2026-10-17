import "server-only";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { dbPath } from "@/server/env";
import * as schema from "./schema";

export type DB = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export function createDb(path: string): DB {
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

export function migrateDb(db: DB): void {
  migrate(db, { migrationsFolder: "./drizzle" });
}

let singleton: DB | undefined;

/** Lazy singleton; resolves DATABASE_URL on first use. */
export function getDb(): DB {
  singleton ??= createDb(dbPath());
  return singleton;
}
