export type DomainErrorCode =
  | "INVALID_INPUT"
  | "PRODUCT_NOT_FOUND"
  | "VARIANT_NOT_FOUND"
  | "SLUG_TAKEN"
  | "SKU_TAKEN"
  | "INSUFFICIENT_STOCK"
  | "STOCK_LIMIT_EXCEEDED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "VERSION_CONFLICT"
  | "PRODUCT_NOT_EDITABLE"
  | "VARIANT_NOT_EDITABLE"
  | "UNAUTHENTICATED"
  | "FORBIDDEN";

/**
 * An expected business failure with a stable code. Its message is safe to show and contains no
 * personal data. Any other thrown error is unexpected and must not be shown to a user.
 */
export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function invalidInput(field: string, problem: string): DomainError {
  return new DomainError("INVALID_INPUT", `${field} ${problem}.`);
}
