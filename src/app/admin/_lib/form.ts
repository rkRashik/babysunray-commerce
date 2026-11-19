import "server-only";
import { pgErrorCode } from "@/db/database";
import { DomainError } from "@/modules/domain-error";
import { parseTakaToPaisa } from "@/modules/money";

// Form handling shared by Admin Server Actions: read only the expected fields, turn service errors
// into safe messages with the labels the Owner sees, and never show or log anything else.

/** An action's answer to its form: a safe message, the typed values to show again, or a one-time link. */
export type FormState = { error?: string; values?: Record<string, string>; link?: string };

/** Field names a form may send back (letters and digits, never the idempotency key). */
export const isFieldName = (name: string) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(name) && name !== "idempotencyKey";

export const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};
export const optional = (form: FormData, name: string): string | null => text(form, name).trim() || null;

export function wholeNumber(raw: string, field: string): number {
  if (!/^[0-9]{1,10}$/.test(raw.trim())) {
    throw new DomainError("INVALID_INPUT", `${field} must be a whole number.`);
  }
  return Number(raw.trim());
}

/** Taka typed by the Owner (e.g. 60 or 60.50) → integer paisa, or a labelled error. */
export const taka = (form: FormData, name: string, label: string) => parseTakaToPaisa(text(form, name), label);

// Validation messages start with the service's field name ("pricePaisa must be ..."); the form shows the
// label the Owner sees instead.
const LABELS: Record<string, string> = {
  slug: "Slug",
  nameEn: "Name (English)",
  nameBn: "Name (Bangla)",
  descriptionEn: "Description (English)",
  descriptionBn: "Description (Bangla)",
  sku: "SKU",
  size: "Size",
  colour: "Colour",
  price: "Price (BDT)",
  pricePaisa: "Price (BDT)",
  quantity: "Units received",
  lineQuantity: "Quantity",
  quantityDelta: "Change",
  units: "Units",
  reason: "Reason",
  customerName: "Customer name",
  phone: "Phone",
  deliveryAddress: "Delivery address",
  note: "Note",
  items: "Items",
  amountPaisa: "Amount",
  occurredOn: "Date",
  reference: "Reference",
  chargePaisa: "Charge",
  rtoChargePaisa: "RTO charge",
  returnShippingCostPaisa: "Return shipping cost",
  bodyEn: "English text",
  bodyBn: "Bangla text",
  contentSha256: "Reviewed content",
};

function readable(message: string): string {
  const [field] = message.split(" ", 1);
  return Object.hasOwn(LABELS, field) ? `${LABELS[field]}${message.slice(field.length)}` : message;
}

/** Safe text for the form: a DomainError message is written to be shown; anything else is generic. */
export function formError(error: unknown, form: FormData): FormState {
  const values: Record<string, string> = {};
  for (const [name, value] of form) if (typeof value === "string" && isFieldName(name)) values[name] = value;
  if (error instanceof DomainError) {
    if (error.code === "IDEMPOTENCY_KEY_REUSED") {
      return { error: "This form was already submitted with different values. Reload the page to make a new entry.", values };
    }
    return { error: readable(error.message), values };
  }
  console.error(
    JSON.stringify({
      level: "error",
      event: "admin_action_failed",
      errorName: error instanceof Error ? error.name : typeof error,
      sqlState: pgErrorCode(error) ?? null,
    }),
  );
  return { error: "Something went wrong and nothing was saved. Please try again.", values };
}
