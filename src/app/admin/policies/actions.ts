"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { DomainError } from "@/modules/domain-error";
import { isPolicyKind, markPolicyReviewedOnce, type PolicyKind, savePolicyDraftOnce } from "@/modules/policies/drafts";
import { publishPolicyOnce, withdrawPolicyOnce } from "@/modules/policies/publication";
import { formError, type FormState, text, wholeNumber } from "../_lib/form";
import { requireAdmin } from "../_lib/session";

// Server Actions of the policy workspace. Each checks the Owner session and its permission itself and calls the shared
// idempotent operation. Saving and reviewing never publish; publishing (policies:publish) needs the explicit approval box.

function kindOf(form: FormData) {
  const kind = text(form, "kind");
  if (!isPolicyKind(kind)) throw new DomainError("INVALID_INPUT", "Unknown policy.");
  return kind;
}

export async function savePolicyAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireAdmin("policies:write");
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
  redirect(`/admin/policies?done=policy-saved#${kind}`);
}

export async function markPolicyReviewedAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireAdmin("policies:write");
  let kind: PolicyKind;
  try {
    kind = kindOf(form);
    await markPolicyReviewedOnce(getDb(), principal, text(form, "idempotencyKey"), { kind, expectedVersion: wholeNumber(text(form, "version"), "Version") });
  } catch (error) {
    return formError(error, form);
  }
  redirect(`/admin/policies?done=policy-reviewed#${kind}`);
}

/** Publishes the reviewed version to customers: the founder's approval of that exact wording (the box must be ticked). */
export async function publishPolicyAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireAdmin("policies:publish");
  let kind: PolicyKind;
  try {
    kind = kindOf(form);
    await publishPolicyOnce(getDb(), principal, text(form, "idempotencyKey"), {
      kind,
      expectedVersion: wholeNumber(text(form, "version"), "Version"),
      approved: text(form, "approve") === "on",
    });
  } catch (error) {
    return formError(error, form);
  }
  redirect(`/admin/policies?done=policyPublished#${kind}`);
}

export async function withdrawPolicyAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireAdmin("policies:publish");
  let kind: PolicyKind;
  try {
    kind = kindOf(form);
    await withdrawPolicyOnce(getDb(), principal, text(form, "idempotencyKey"), { kind });
  } catch (error) {
    return formError(error, form);
  }
  redirect(`/admin/policies?done=policyWithdrawn#${kind}`);
}
