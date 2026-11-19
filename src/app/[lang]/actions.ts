"use server";

import { requireShop } from "@/app/_shop/access";
import { getDb } from "@/db/client";
import { DomainError } from "@/modules/domain-error";
import { type CheckoutResult, checkCheckout, PUBLIC_SCOPE, type Quote, quoteLines } from "@/modules/storefront/service";

// Server Actions of the shop. Each checks shop access itself (a closed shop answers 404, like its pages) and only READS:
// the quote prices the bag from the database (published products only), and the check validates the checkout details the
// way the order will be validated. Placing the order is POST /api/shop/checkout, never an action here.

export async function quoteShopCartAction(input: { lines: unknown; zone: unknown }): Promise<Quote | null> {
  await requireShop();
  try {
    return await quoteLines(getDb(), input, PUBLIC_SCOPE);
  } catch (error) {
    if (error instanceof DomainError && error.code === "INVALID_INPUT") return null;
    throw error;
  }
}

export async function checkShopCheckoutAction(_: CheckoutResult | null, form: FormData): Promise<CheckoutResult> {
  await requireShop();
  let lines: unknown = null;
  try {
    lines = JSON.parse(String(form.get("lines") ?? "[]"));
  } catch {
    lines = null;
  }
  return checkCheckout(getDb(), { name: form.get("name"), phone: form.get("phone"), address: form.get("address"), zone: form.get("zone"), lines }, PUBLIC_SCOPE);
}
