import "server-only";

export type BillingErrorCode =
  | "UNAUTHENTICATED"
  | "PLAN_NOT_FOUND"
  | "STRIPE_NOT_CONFIGURED"
  | "NO_STRIPE_CUSTOMER";

export class BillingError extends Error {
  constructor(readonly code: BillingErrorCode) {
    super(code);
    this.name = "BillingError";
  }
}
