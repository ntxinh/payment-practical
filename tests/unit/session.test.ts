import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySessionValue } from "@/server/auth/session";

describe("verifySessionValue", () => {
  // sign is not exported; forge a valid cookie through the same HMAC recipe.
  const make = (uid: string) => {
    return `${uid}.${createHmac("sha256", "dev-only-insecure-secret").update(uid).digest("hex")}`;
  };

  it("returns userId for a valid signature", () => {
    expect(verifySessionValue(make("u123"))).toBe("u123");
  });
  it("rejects tampered signature and malformed values", () => {
    expect(verifySessionValue(`${make("u123")}x`)).toBeNull();
    expect(verifySessionValue("u123.")).toBeNull();
    expect(verifySessionValue("no-separator")).toBeNull();
    expect(verifySessionValue("")).toBeNull();
  });
});
