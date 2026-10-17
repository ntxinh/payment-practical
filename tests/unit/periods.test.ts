import { describe, expect, it } from "vitest";
import { periodMs } from "@/server/modules/billing/subscriptions";

const DAY = 86_400_000;

describe("periodMs", () => {
  it("month → 30 days", () => {
    expect(periodMs("month")).toBe(30 * DAY);
  });

  it("year → 365 days", () => {
    expect(periodMs("year")).toBe(365 * DAY);
  });

  it("unknown interval (week) → 30-day fallback", () => {
    expect(periodMs("week")).toBe(30 * DAY);
  });
});
