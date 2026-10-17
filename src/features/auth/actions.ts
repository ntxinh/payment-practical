"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { ulid } from "ulidx";
import { clearSessionCookie, setSessionCookie } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { users } from "@/server/db/schema";

export async function login(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  if (!email.includes("@")) redirect("/login?error=INVALID_EMAIL");
  const db = getDb();
  let user = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (!user) {
    db.insert(users).values({ id: ulid(), email, createdAt: Date.now() }).run();
    user = await db.query.users.findFirst({ where: eq(users.email, email) });
  }
  if (!user) throw new Error("user insert failed");
  await setSessionCookie(user.id);
  redirect("/pricing");
}

export async function logout(): Promise<void> {
  await clearSessionCookie();
  redirect("/");
}
