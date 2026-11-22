"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { savePaymentMethodOnce } from "@/modules/settings/payments";
import { formError, type FormState, text, wholeNumber } from "../../_lib/form";
import { requireAdmin } from "../../_lib/session";

// Payment methods (src/modules/settings/payments.ts): the Owner's session and settings:write are checked here and again
// by the operation.
export async function savePaymentMethodAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireAdmin("settings:write");
  try {
    await savePaymentMethodOnce(getDb(), principal, text(form, "idempotencyKey"), {
      method: text(form, "method"),
      expectedVersion: wholeNumber(text(form, "version") || "0", "Version"),
      enabled: text(form, "enabled") === "on",
      approved: text(form, "approved") === "on",
      accountName: text(form, "accountName"),
      accountNumber: text(form, "accountNumber"),
      accountKind: text(form, "accountKind"),
      bankName: text(form, "bankName"),
      branchName: text(form, "branchName"),
      routingNumber: text(form, "routingNumber"),
      instructionsEn: text(form, "instructionsEn"),
      instructionsBn: text(form, "instructionsBn"),
    });
  } catch (error) {
    return formError(error, form);
  }
  redirect("/admin/settings/payments?done=payment-saved");
}
