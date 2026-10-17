import "server-only";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulidx";
import type { DB } from "@/server/db/client";
import { webhookEvents } from "@/server/db/schema";

export function seenEvent(db: DB, eventId: string, provider: "stripe" | "finix"): boolean {
  return (
    db
      .select({ eventId: webhookEvents.eventId })
      .from(webhookEvents)
      .where(and(eq(webhookEvents.eventId, eventId), eq(webhookEvents.provider, provider)))
      .get() !== undefined
  );
}

export function recordEvent(
  db: DB,
  eventId: string,
  type: string,
  provider: "stripe" | "finix",
): void {
  db.insert(webhookEvents)
    .values({ id: ulid(), eventId, type, provider, processedAt: Date.now() })
    .onConflictDoNothing()
    .run();
}
