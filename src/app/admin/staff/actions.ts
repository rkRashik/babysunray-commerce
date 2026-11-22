"use server";

import { redirect } from "next/navigation";
import { currentStoreIdentity } from "@/app/_design/identity";
import { getDb } from "@/db/client";
import { getAuth } from "@/modules/auth/server";
import {
  changeStaffRoleOnce,
  inviteStaffOnce,
  LINK_HOURS,
  redeemStaffLink,
  revokeStaffLinkOnce,
  revokeStaffSessionsOnce,
  sendPasswordLinkOnce,
  type StaffLinkDeps,
  type StaffLinkResult,
  setStaffEnabledOnce,
  staffLinkView,
} from "@/modules/auth/staff";
import { DomainError } from "@/modules/domain-error";
import { emailAvailable, emailSender } from "@/modules/email/service";
import { formError, type FormState, text } from "../_lib/form";
import { requireAdmin } from "../_lib/session";

// Staff & access (src/modules/auth/staff.ts). Every action checks the Owner's session and users:manage itself and calls the
// shared idempotent operation. A link that was not emailed is answered once in the form state, never in a URL.

const back = (done: string) => redirect(`/admin/staff?done=${done}`);

async function linkDeps(): Promise<StaffLinkDeps> {
  const { storeName } = await currentStoreIdentity();
  return { send: emailAvailable() ? emailSender() : null, baseUrl: getAuth().options.baseURL ?? "", storeName };
}

function linkAnswer(result: StaffLinkResult, kind: "invite" | "password"): FormState | null {
  if (result.emailed) return null;
  if (!result.token) return { error: "This link was already created and cannot be shown again. Create a new one." };
  const link = `${getAuth().options.baseURL}/admin/invite#t=${result.token}`;
  const what = kind === "invite" ? "Invitation link" : "Set-password link";
  return { link, linkNote: `${what}. Email was not sent, so send this link privately to the person now (it works once, for ${LINK_HOURS} hours). It is shown only once.` };
}

export async function inviteStaffAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireAdmin("users:manage");
  let answer: FormState | null;
  try {
    const result = await inviteStaffOnce(getDb(), principal, text(form, "idempotencyKey"), { email: text(form, "email"), role: text(form, "role") }, await linkDeps());
    answer = linkAnswer(result, "invite");
  } catch (error) {
    return formError(error, form);
  }
  if (answer) return answer;
  back("invited");
  return {};
}

export async function passwordLinkAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireAdmin("users:manage");
  let answer: FormState | null;
  try {
    const result = await sendPasswordLinkOnce(getDb(), principal, text(form, "idempotencyKey"), { userId: text(form, "userId") }, await linkDeps());
    answer = linkAnswer(result, "password");
  } catch (error) {
    return formError(error, form);
  }
  if (answer) return answer;
  back("password-link");
  return {};
}

export async function revokeLinkAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireAdmin("users:manage");
  try {
    await revokeStaffLinkOnce(getDb(), principal, text(form, "idempotencyKey"), { invitationId: text(form, "invitationId") });
  } catch (error) {
    return formError(error, form);
  }
  back("link-revoked");
  return {};
}

export async function changeRoleAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireAdmin("users:manage");
  try {
    await changeStaffRoleOnce(getDb(), principal, text(form, "idempotencyKey"), { userId: text(form, "userId"), fromRole: text(form, "fromRole"), toRole: text(form, "role") });
  } catch (error) {
    return formError(error, form);
  }
  back("role-changed");
  return {};
}

export async function setEnabledAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireAdmin("users:manage");
  const enabled = text(form, "enabled") === "true";
  try {
    await setStaffEnabledOnce(getDb(), principal, text(form, "idempotencyKey"), { userId: text(form, "userId"), enabled });
  } catch (error) {
    return formError(error, form);
  }
  back(enabled ? "staff-enabled" : "staff-disabled");
  return {};
}

export async function revokeSessionsAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireAdmin("users:manage");
  try {
    await revokeStaffSessionsOnce(getDb(), principal, text(form, "idempotencyKey"), { userId: text(form, "userId") });
  } catch (error) {
    return formError(error, form);
  }
  back("sessions-ended");
  return {};
}

// --- Redeeming a link: no session, the token in the POST body is the credential (rate limited, never logged) --------

export type LinkAnswer = { ok: true; kind: "invite" | "password"; email: string; roleLabel: string } | { ok: false; error: string };

function linkFailure(error: unknown): { ok: false; error: string } {
  if (error instanceof DomainError) return { ok: false, error: error.message };
  if (error instanceof Error && /password|name must|email address/i.test(error.message)) return { ok: false, error: error.message };
  console.error(JSON.stringify({ level: "error", event: "staff_link_failed", errorName: error instanceof Error ? error.name : typeof error }));
  return { ok: false, error: "That did not work and nothing was changed. Try again." };
}

export async function staffLinkAction(token: string): Promise<LinkAnswer> {
  try {
    const view = await staffLinkView(getDb(), token);
    return { ok: true, kind: view.kind, email: view.email, roleLabel: view.roleLabel };
  } catch (error) {
    return linkFailure(error);
  }
}

export async function redeemLinkAction(input: { token: string; name: string; password: string }): Promise<{ ok: true; kind: "invite" | "password" } | { ok: false; error: string }> {
  try {
    const { kind } = await redeemStaffLink(getDb(), input);
    return { ok: true, kind };
  } catch (error) {
    return linkFailure(error);
  }
}
