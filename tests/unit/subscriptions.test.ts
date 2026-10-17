import { describe, expect, it } from "vitest";
import { isActive, mapSubscriptionStatus } from "@/server/modules/billing/subscriptions";

describe("mapSubscriptionStatus", () => {
  it.each([
    "active",
    "trialing",
    "past_due",
    "canceled",
    "paused",
    "incomplete",
    "incomplete_expired",
    "unpaid",
  ] as const)("passes through %s", (s) => expect(mapSubscriptionStatus(s)).toBe(s));
  it("maps unknown future statuses to unpaid (never grants access)", () => {
    expect(mapSubscriptionStatus("some_future_status")).toBe("unpaid");
  });
});

describe("isActive", () => {
  it("grants access only for active/trialing", () => {
    expect(isActive("active")).toBe(true);
    expect(isActive("trialing")).toBe(true);
    expect(isActive("paused")).toBe(false);
    expect(isActive("past_due")).toBe(false);
  });
});
