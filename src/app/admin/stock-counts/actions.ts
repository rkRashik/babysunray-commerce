"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { DomainError } from "@/modules/domain-error";
import { MAX_COUNT_LINES } from "@/modules/inventory/counts";
import { applyStockCountOnce, discardStockCountOnce, recordCountsOnce, startStockCountOnce } from "@/modules/inventory/operations";
import { formError, type FormState, optional, text, wholeNumber } from "../_lib/form";
import { requireAdmin } from "../_lib/session";

// Stock count actions. Same rules as ../actions.ts: each verifies the session cookie and the permission itself,
// reads only its own fields, calls the shared idempotent operation directly and records the signed-in user.
// Count changes carry the version the page was rendered from, so a stale tab is refused.

const countRef = (form: FormData) => ({ countId: text(form, "countId"), expectedVersion: wholeNumber(text(form, "version"), "Version") });
const back = (countId: string, done: string) => redirect(`/admin/stock-counts/${encodeURIComponent(countId)}?done=${done}`);

export async function startCountAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireAdmin("stock:count");
  let countId: string;
  try {
    const scope = text(form, "scope");
    if (scope !== "all" && scope !== "selected") throw new DomainError("INVALID_INPUT", "Choose what to count.");
    const { value } = await startStockCountOnce(getDb(), principal, text(form, "idempotencyKey"), { scope, skus: scope === "selected" ? [text(form, "skus")] : [] });
    countId = value.id;
  } catch (error) {
    return formError(error, form);
  }
  back(countId, "started");
  return {};
}

export async function recordCountsAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireAdmin("stock:count");
  const ref = countRef(form);
  try {
    const entries = [];
    for (let i = 0; i < MAX_COUNT_LINES; i += 1) {
      const variantId = text(form, `id${i}`);
      if (!variantId) break;
      const raw = text(form, `count${i}`).trim();
      entries.push({ variantId, counted: raw === "" ? null : wholeNumber(raw, `Counted units (line ${i + 1})`), recounted: text(form, `recount${i}`) === "on" });
    }
    await recordCountsOnce(getDb(), principal, text(form, "idempotencyKey"), { ...ref, entries });
  } catch (error) {
    return formError(error, form);
  }
  back(ref.countId, "counts-saved");
  return {};
}

export async function applyCountAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireAdmin("stock:adjust");
  const ref = countRef(form);
  try {
    await applyStockCountOnce(getDb(), principal, text(form, "idempotencyKey"), { ...ref, reason: optional(form, "reason") });
  } catch (error) {
    return formError(error, form);
  }
  back(ref.countId, "applied");
  return {};
}

export async function discardCountAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireAdmin("stock:count");
  const ref = countRef(form);
  try {
    await discardStockCountOnce(getDb(), principal, text(form, "idempotencyKey"), ref);
  } catch (error) {
    return formError(error, form);
  }
  back(ref.countId, "discarded");
  return {};
}
