import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { getDb } from "@/server/db/client";
import { type User, users } from "@/server/db/schema";
import { sessionSecret } from "@/server/env";

const COOKIE = "session";

/** Pure verifier — returns the userId or null. */
export function verifySessionValue(value: string): string | null {
  const i = value.lastIndexOf(".");
  if (i <= 0) return null;
  const userId = value.slice(0, i);
  const sig = Buffer.from(value.slice(i + 1));
  const expected = Buffer.from(createHmac("sha256", sessionSecret()).update(userId).digest("hex"));
  return sig.length === expected.length && timingSafeEqual(sig, expected) ? userId : null;
}

export async function setSessionCookie(userId: string): Promise<void> {
  (await cookies()).set(
    COOKIE,
    `${userId}.${createHmac("sha256", sessionSecret()).update(userId).digest("hex")}`,
    { httpOnly: true, sameSite: "lax", path: "/" },
  );
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

export async function getCurrentUser(): Promise<User | null> {
  const value = (await cookies()).get(COOKIE)?.value;
  const userId = value && verifySessionValue(value);
  if (!userId) return null;
  return (await getDb().query.users.findFirst({ where: eq(users.id, userId) })) ?? null;
}
