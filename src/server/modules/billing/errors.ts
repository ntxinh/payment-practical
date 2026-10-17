import "server-only";

export type BillingErrorCode =
  | "UNAUTHENTICATED"
  | "PLAN_NOT_FOUND"
  | "STRIPE_NOT_CONFIGURED"
  | "NO_STRIPE_CUSTOMER"
  | "FINIX_NOT_CONFIGURED"
  | "FINIX_INSTRUMENT_INVALID"
  | "FINIX_NO_INSTRUMENT"
  | "FINIX_SUB_EXISTS";

export class BillingError extends Error {
  constructor(readonly code: BillingErrorCode) {
    super(code);
    this.name = "BillingError";
  }
}
