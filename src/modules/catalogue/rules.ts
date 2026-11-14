import { invalidInput } from "../domain-error";

// Input validation for the catalogue. The same limits are enforced by CHECK constraints in src/db/schema.ts.
// Length limits are technical bounds, not merchandising policy.

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// Canonical stored SKU: ASCII uppercase letters, digits, hyphen and underscore (founder-approved, Gate G.3a).
const SKU = /^[A-Z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Canonical SKU: surrounding whitespace removed and lowercase ASCII letters uppercased, then validated.
 * Only a-z is converted (not toUpperCase()), so a Unicode letter can never turn into ASCII; it is rejected.
 */
export function normalizeSku(raw: string): string {
  if (typeof raw !== "string") throw invalidInput("sku", "must be text");
  const sku = raw.trim().replace(/[a-z]/g, (c) => c.toUpperCase());
  if (sku.length === 0) throw invalidInput("sku", "is required");
  if (!SKU.test(sku)) {
    throw invalidInput("sku", "must be 1-64 characters: letters A-Z, digits, hyphen and underscore only");
  }
  return sku;
}

/** URL slug: lowercase ASCII letters and digits separated by single hyphens. */
export function validateSlug(raw: string): string {
  if (typeof raw !== "string") throw invalidInput("slug", "must be text");
  const slug = raw.trim();
  if (!SLUG.test(slug) || slug.length > 100) {
    throw invalidInput("slug", "must be 1-100 lowercase letters, digits and single hyphens");
  }
  return slug;
}

/** Optional free text: trimmed; empty or missing becomes null. */
export function optionalText(raw: string | null | undefined, field: string, maxLength: number): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw invalidInput(field, "must be text");
  const text = raw.trim();
  if (text.length > maxLength) throw invalidInput(field, `must be at most ${maxLength} characters`);
  return text.length === 0 ? null : text;
}

/** Price in integer paisa: positive, and exact as a JavaScript number. */
export function validatePricePaisa(raw: number): number {
  if (!Number.isSafeInteger(raw) || raw <= 0) throw invalidInput("pricePaisa", "must be a positive whole number of paisa");
  return raw;
}

export function validateId(raw: string, field: string): string {
  if (typeof raw !== "string" || !UUID.test(raw)) throw invalidInput(field, "must be a UUID");
  return raw.toLowerCase();
}
