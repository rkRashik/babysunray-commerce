import { invalidInput } from "../domain-error";

// Stock quantities are PostgreSQL integers; this is a technical bound, not a business limit.
export const MAX_STOCK_QUANTITY = 2_147_483_647;

/** Units received: a positive whole number. */
export function validateReceiptQuantity(raw: number): number {
  if (!Number.isSafeInteger(raw) || raw < 1 || raw > MAX_STOCK_QUANTITY) {
    throw invalidInput("quantity", "must be a positive whole number");
  }
  return raw;
}

/** Adjustment: a non-zero whole number; negative removes stock. */
export function validateAdjustmentDelta(raw: number): number {
  if (!Number.isSafeInteger(raw) || raw === 0 || Math.abs(raw) > MAX_STOCK_QUANTITY) {
    throw invalidInput("quantityDelta", "must be a non-zero whole number");
  }
  return raw;
}

/** Reason text, trimmed. Required for adjustments (requirement I-3), optional for receipts. */
export function validateReason(raw: string | null | undefined, required: boolean): string | null {
  if (raw === undefined || raw === null) {
    if (required) throw invalidInput("reason", "is required");
    return null;
  }
  if (typeof raw !== "string") throw invalidInput("reason", "must be text");
  const reason = raw.trim();
  if (reason.length > 500) throw invalidInput("reason", "must be at most 500 characters");
  if (reason.length === 0) {
    if (required) throw invalidInput("reason", "is required");
    return null;
  }
  return reason;
}
