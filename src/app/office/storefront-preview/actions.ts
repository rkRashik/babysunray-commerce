"use server";

import { getDb } from "@/db/client";
import { DomainError } from "@/modules/domain-error";
import { type CheckoutResult, type Quote, quoteCart, simulateCheckout } from "@/modules/storefront/service";
import { requireOffice } from "../_lib/session";

// Server Actions of the storefront preview. Each checks the Owner session and `storefront:preview` itself; an
// anonymous caller is sent to sign-in. They only read: the quote recomputes prices, stock and the delivery
// charge from the database, and the checkout is a simulation (simulateCheckout never records an order).

/** The cart priced and checked now, or null when the cart content itself is malformed. */
export async function quoteCartAction(input: { lines: unknown; zone: unknown }): Promise<Quote | null> {
  const principal = await requireOffice("storefront:preview");
  try {
    return await quoteCart(getDb(), principal, input);
  } catch (error) {
    if (error instanceof DomainError && error.code === "INVALID_INPUT") return null;
    throw error;
  }
}

/** The checkout form, validated and priced, never submitted: no order, reservation, message or log of the details. */
export async function simulateCheckoutAction(_: CheckoutResult | null, form: FormData): Promise<CheckoutResult> {
  const principal = await requireOffice("storefront:preview");
  let lines: unknown = null;
  try {
    lines = JSON.parse(String(form.get("lines") ?? "[]"));
  } catch {
    lines = null;
  }
  return simulateCheckout(getDb(), principal, { name: form.get("name"), phone: form.get("phone"), address: form.get("address"), zone: form.get("zone"), lines });
}
