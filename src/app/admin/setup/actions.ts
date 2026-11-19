"use server";

import { currentStoreIdentity } from "@/app/_design/identity";
import { getDb } from "@/db/client";
import { completeSetup, recoverOwner, startSetup } from "@/modules/auth/setup";
import { DomainError } from "@/modules/domain-error";
import { EmailFailed, emailAvailable, emailSender } from "@/modules/email/service";

// First-time Admin setup and Owner recovery (src/modules/auth/setup.ts). These are the only Admin Server Actions that run
// without a session: each is refused server-side once an Owner exists (setup) or without a valid recovery code (recovery),
// and each is rate limited. The setup code (ADMIN_SETUP_TOKEN) travels in the POST body only and is never logged or echoed.

export type SetupAnswer = { ok: true; codeSent?: boolean; recoveryCodes?: string[]; emailVerified?: boolean } | { ok: false; error: string };

function failure(error: unknown): SetupAnswer {
  if (error instanceof DomainError) return { ok: false, error: error.message };
  if (error instanceof EmailFailed) return { ok: false, error: "The email could not be sent. Check the email settings, or try again in a moment." };
  if (error instanceof Error && /password|email address|name must/i.test(error.message)) return { ok: false, error: error.message };
  console.error(JSON.stringify({ level: "error", event: "admin_setup_failed", errorName: error instanceof Error ? error.name : typeof error }));
  return { ok: false, error: "Setup could not finish. Nothing was changed. Try again." };
}

export async function startSetupAction(input: { token: string; email: string }): Promise<SetupAnswer> {
  try {
    const send = emailAvailable() ? emailSender() : null;
    const { storeName } = await currentStoreIdentity();
    const { codeSent } = await startSetup(getDb(), input, { env: process.env, send, storeName });
    return { ok: true, codeSent };
  } catch (error) {
    return failure(error);
  }
}

export async function completeSetupAction(input: { token: string; email: string; name: string; password: string; code: string }): Promise<SetupAnswer> {
  try {
    const result = await completeSetup(getDb(), input, { env: process.env, emailRequired: emailAvailable() });
    return { ok: true, recoveryCodes: result.recoveryCodes, emailVerified: result.emailVerified };
  } catch (error) {
    return failure(error);
  }
}

export async function recoverOwnerAction(input: { email: string; code: string; password: string }): Promise<SetupAnswer> {
  try {
    await recoverOwner(getDb(), input);
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}
