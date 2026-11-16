"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { DomainError } from "@/modules/domain-error";
import { type CheckoutResult, type Quote, quoteCart, simulateCheckout } from "@/modules/storefront/service";
import { requireOffice } from "../_lib/session";
import { CONCEPT_COOKIE, isConcept } from "./_components/concept";

// Server Actions of the storefront preview. Each checks the Owner session and `storefront:preview` itself; an
// anonymous caller is sent to sign-in. They only read (apart from the design-concept cookie, a layout choice): the quote recomputes prices, stock and the delivery
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

// Only paths inside the preview, so the choice can never redirect anywhere else.
const SAFE_RETURN = /^\/office\/storefront-preview(?:\/(?:en|bn)(?:\/[A-Za-z0-9._~%-]+)*)?\/?(?:\?[A-Za-z0-9._~%&=+-]*)?$/;

/** Remembers which design concept to show (a layout choice only) and returns to the same preview page. */
export async function chooseConceptAction(form: FormData): Promise<void> {
  await requireOffice("storefront:preview");
  const concept = form.get("concept");
  const back = String(form.get("returnTo") ?? "");
  if (isConcept(concept)) {
    // HttpOnly, path-scoped, half a year. Not Secure-only: it carries a layout word, never a credential.
    (await cookies()).set(CONCEPT_COOKIE, concept, { path: "/office/storefront-preview", httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 180 });
  }
  redirect(back.length <= 600 && SAFE_RETURN.test(back) ? back : "/office/storefront-preview/en");
}
