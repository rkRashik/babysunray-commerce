"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { regenerateRecoveryCodes } from "@/modules/auth/setup";
import { approvePublicationRuleOnce, updateStoreIdentityOnce } from "@/modules/settings/store";
import { formError, type FormState, text, wholeNumber } from "../_lib/form";
import { requireAdmin } from "../_lib/session";

// Server Actions of the store settings. Each checks the Owner session and its permission itself and calls the shared
// idempotent operation (src/modules/settings/store.ts).

export async function updateStoreIdentityAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireAdmin("settings:write");
  try {
    await updateStoreIdentityOnce(getDb(), principal, text(form, "idempotencyKey"), {
      expectedVersion: wholeNumber(text(form, "version") || "0", "Version"),
      storeName: text(form, "storeName"),
      lineEn: text(form, "lineEn"),
      lineBn: text(form, "lineBn"),
      contactPhone: text(form, "contactPhone"),
      contactEmail: text(form, "contactEmail"),
      contactWhatsapp: text(form, "contactWhatsapp"),
      contactMessenger: text(form, "contactMessenger"),
    });
  } catch (error) {
    return formError(error, form);
  }
  redirect("/admin/settings/store?done=storeSaved");
}

export async function approvePublicationRuleAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireAdmin("catalog:publish");
  try {
    await approvePublicationRuleOnce(getDb(), principal, text(form, "idempotencyKey"), {
      expectedVersion: wholeNumber(text(form, "version") || "0", "Version"),
      items: form.getAll("items").filter((v): v is string => typeof v === "string"),
      approved: text(form, "approve") === "on",
    });
  } catch (error) {
    return formError(error, form);
  }
  redirect("/admin/settings/publication?done=ruleApproved");
}

/** New recovery codes for the signed-in Owner, returned once to the page (never in a URL). */
export async function regenerateRecoveryCodesAction(): Promise<string[]> {
  const principal = await requireAdmin();
  return regenerateRecoveryCodes(getDb(), principal.userId);
}
