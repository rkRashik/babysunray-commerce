"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { DomainError } from "@/modules/domain-error";
import { isPolicyKind, markPolicyReviewedOnce, type PolicyKind, savePolicyDraftOnce } from "@/modules/policies/drafts";
import { formError, type FormState, text, wholeNumber } from "../_lib/form";
import { requireOffice } from "../_lib/session";

// Server Actions of the private policy workspace. Each checks the Owner session and `policies:write` itself and
// calls the shared idempotent operation. Nothing here publishes a policy or shows it to a customer.

function kindOf(form: FormData) {
  const kind = text(form, "kind");
  if (!isPolicyKind(kind)) throw new DomainError("INVALID_INPUT", "Unknown policy.");
  return kind;
}

export async function savePolicyAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireOffice("policies:write");
  let kind: PolicyKind;
  try {
    kind = kindOf(form);
    await savePolicyDraftOnce(getDb(), principal, text(form, "idempotencyKey"), {
      kind,
      expectedVersion: wholeNumber(text(form, "version"), "Version"),
      bodyEn: text(form, "bodyEn"),
      bodyBn: text(form, "bodyBn"),
    });
  } catch (error) {
    return formError(error, form);
  }
  redirect(`/office/policies?done=policy-saved#${kind}`);
}

export async function markPolicyReviewedAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireOffice("policies:write");
  let kind: PolicyKind;
  try {
    kind = kindOf(form);
    await markPolicyReviewedOnce(getDb(), principal, text(form, "idempotencyKey"), { kind, expectedVersion: wholeNumber(text(form, "version"), "Version") });
  } catch (error) {
    return formError(error, form);
  }
  redirect(`/office/policies?done=policy-reviewed#${kind}`);
}
