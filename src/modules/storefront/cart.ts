import { normalizeSku } from "../catalogue/rules";
import { DomainError } from "../domain-error";
import { MAX_LINE_QUANTITY, MAX_ORDER_LINES } from "../orders/rules";

// The preview cart: SKUs and quantities only, kept in the browser. Prices, names and stock are never taken
// from it; they are read from the database each time (quote.ts). The same bounds as an order (at most 20
// lines, 1 to 1,000 of each), so a cart that passes here could be submitted under today's order rules.
// Plain functions, safe in client components.

export type CartLine = { sku: string; quantity: number };
export const MAX_CART_LINES = MAX_ORDER_LINES;
export const MAX_CART_QUANTITY = MAX_LINE_QUANTITY;

/** A whole number of units typed by a person: 1 to 1,000, digits only (Bangla digits accepted), else null. */
export function parseQuantity(raw: string): number | null {
  const text = raw.trim().replace(/[০-৯]/g, (d) => String("০১২৩৪৫৬৭৮৯".indexOf(d)));
  if (!/^[0-9]{1,4}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= MAX_CART_QUANTITY ? n : null;
}

/**
 * Cart lines from an untrusted source (browser storage, a request): each SKU canonical and once (quantities
 * added), each quantity 1 to 1,000, at most 20 lines. Anything malformed is refused, not repaired.
 */
export function validateCartLines(raw: unknown): CartLine[] {
  if (!Array.isArray(raw)) throw new DomainError("INVALID_INPUT", "The cart must be a list.");
  if (raw.length > MAX_CART_LINES) throw new DomainError("INVALID_INPUT", `The cart can hold at most ${MAX_CART_LINES} items.`);
  const merged = new Map<string, number>();
  for (const line of raw) {
    if (typeof line !== "object" || line === null) throw new DomainError("INVALID_INPUT", "A cart line is malformed.");
    const { sku, quantity } = line as { sku?: unknown; quantity?: unknown };
    if (typeof sku !== "string" || typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity < 1) {
      throw new DomainError("INVALID_INPUT", "A cart line is malformed.");
    }
    const key = normalizeSku(sku);
    const total = (merged.get(key) ?? 0) + quantity;
    if (total > MAX_CART_QUANTITY) throw new DomainError("INVALID_INPUT", `At most ${MAX_CART_QUANTITY} of one item.`);
    merged.set(key, total);
  }
  return [...merged].map(([sku, quantity]) => ({ sku, quantity }));
}

/** Adds units of a SKU to a cart (pure; the caller stores the result). */
export function addToCart(lines: CartLine[], sku: string, quantity: number): CartLine[] {
  const existing = lines.find((l) => l.sku === sku);
  if (!existing) return [...lines, { sku, quantity }];
  return lines.map((l) => (l.sku === sku ? { ...l, quantity: l.quantity + quantity } : l));
}

export const setQuantity = (lines: CartLine[], sku: string, quantity: number) => lines.map((l) => (l.sku === sku ? { ...l, quantity } : l));
export const removeLine = (lines: CartLine[], sku: string) => lines.filter((l) => l.sku !== sku);
export const cartUnits = (lines: CartLine[]) => lines.reduce((sum, l) => sum + l.quantity, 0);
