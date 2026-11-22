import "server-only";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db/database";
import { paymentMethods } from "@/db/schema";
import { actorFor, assertPermission, type Principal } from "../auth/principal";
import { DomainError, invalidInput } from "../domain-error";
import { type Once, runOnce } from "../idempotency/service";
import { normalizeBdPhone } from "../orders/rules";

// The store's manual payment methods (ADR-0013): where a customer may send an advance payment by bKash, Nagad or bank
// transfer. Cash on delivery needs no setting and is always offered. Nothing is prefilled: a method is offered only after
// the Owner enters its receiving details and confirms the account may receive the store's payments. No gateway is
// connected, so there is no credential to keep, and no customer PIN, OTP or banking password is ever asked for.

export const MANUAL_METHODS = ["bkash", "nagad", "bank_transfer"] as const;
export type ManualMethod = (typeof MANUAL_METHODS)[number];
export const isManualMethod = (value: unknown): value is ManualMethod => typeof value === "string" && (MANUAL_METHODS as readonly string[]).includes(value);
export const METHOD_LABELS: Record<ManualMethod, { en: string; bn: string }> = {
  bkash: { en: "bKash", bn: "বিকাশ" },
  nagad: { en: "Nagad", bn: "নগদ" },
  bank_transfer: { en: "Bank transfer", bn: "ব্যাংক ট্রান্সফার" },
};

export type PaymentMethodRow = typeof paymentMethods.$inferSelect;

/** What a customer is shown for an enabled method: receiving details and the Owner's short instructions only. */
export type PaymentDetails = {
  method: ManualMethod;
  accountName: string;
  accountNumber: string;
  accountKind: "merchant" | "personal" | null;
  bankName: string | null;
  branchName: string | null;
  routingNumber: string | null;
  instructions: { en: string | null; bn: string | null };
};

const toDetails = (r: PaymentMethodRow): PaymentDetails => ({
  method: r.method,
  accountName: r.accountName!,
  accountNumber: r.accountNumber!,
  accountKind: r.accountKind,
  bankName: r.bankName,
  branchName: r.branchName,
  routingNumber: r.routingNumber,
  instructions: { en: r.instructionsEn, bn: r.instructionsBn },
});

/** The methods customers may choose now, in a fixed order. Empty until the Owner enables one. */
export async function enabledPaymentMethods(db: Db): Promise<PaymentDetails[]> {
  const rows = await db.select().from(paymentMethods).where(eq(paymentMethods.enabled, true));
  return MANUAL_METHODS.map((m) => rows.find((r) => r.method === m)).filter((r): r is PaymentMethodRow => Boolean(r)).map(toDetails);
}

/** One method's customer details if it is enabled now, else null. */
export async function paymentDetails(db: Db, method: string): Promise<PaymentDetails | null> {
  if (!isManualMethod(method)) return null;
  const [row] = await db.select().from(paymentMethods).where(eq(paymentMethods.method, method));
  return row?.enabled ? toDetails(row) : null;
}

/** Every saved method, for the Owner's settings page (settings:write). */
export async function paymentMethodsForAdmin(db: Db, principal: Principal): Promise<Map<ManualMethod, PaymentMethodRow>> {
  assertPermission(principal, "settings:write");
  const rows = await db.select().from(paymentMethods);
  return new Map(rows.map((r) => [r.method, r]));
}

const CONTROL = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

function textField(raw: unknown, field: string, max: number, multiline = false): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") throw invalidInput(field, "must be text");
  const value = raw.normalize("NFC").trim();
  if (value === "") return null;
  if (value.length > max || CONTROL.test(value) || (!multiline && /[\r\n]/.test(value))) throw invalidInput(field, `must be at most ${max} characters${multiline ? "" : " on one line"}`);
  return value;
}

export type PaymentMethodInput = {
  method: unknown;
  expectedVersion: number;
  enabled: boolean;
  approved: boolean;
  accountName: unknown;
  accountNumber: unknown;
  accountKind: unknown;
  bankName: unknown;
  branchName: unknown;
  routingNumber: unknown;
  instructionsEn: unknown;
  instructionsBn: unknown;
};

/** Checks one method's details. Turning a method on needs complete details and the Owner's explicit approval. */
export function validatePaymentMethod(input: PaymentMethodInput) {
  if (!isManualMethod(input.method)) throw invalidInput("method", "must be bkash, nagad or bank_transfer");
  const method = input.method;
  const bank = method === "bank_transfer";
  const rawNumber = textField(input.accountNumber, "accountNumber", 40);
  let accountNumber: string | null = null;
  if (rawNumber) {
    if (bank) {
      accountNumber = rawNumber.replace(/[\s-]/g, "");
      if (!/^[0-9]{6,34}$/.test(accountNumber)) throw invalidInput("accountNumber", "must be the bank account number (6 to 34 digits)");
    } else {
      try {
        accountNumber = normalizeBdPhone(rawNumber);
      } catch {
        throw invalidInput("accountNumber", `must be the ${METHOD_LABELS[method].en} receiving number, such as 01712345678`);
      }
    }
  }
  const kind = input.accountKind === "" || input.accountKind === null || input.accountKind === undefined ? null : input.accountKind;
  if (bank && kind !== null) throw invalidInput("accountKind", "is only for bKash and Nagad");
  if (kind !== null && kind !== "merchant" && kind !== "personal") throw invalidInput("accountKind", "must be merchant or personal");
  const routing = textField(input.routingNumber, "routingNumber", 20)?.replace(/\s/g, "") ?? null;
  if (routing !== null && (!bank || !/^[0-9]{9}$/.test(routing))) throw invalidInput("routingNumber", "must be the 9-digit routing number (bank transfer only)");
  const values = {
    method,
    accountName: textField(input.accountName, "accountName", 80),
    accountNumber,
    accountKind: kind as "merchant" | "personal" | null,
    bankName: bank ? textField(input.bankName, "bankName", 80) : null,
    branchName: bank ? textField(input.branchName, "branchName", 80) : null,
    routingNumber: routing,
    instructionsEn: textField(input.instructionsEn, "instructionsEn", 300, true),
    instructionsBn: textField(input.instructionsBn, "instructionsBn", 300, true),
  };
  if (input.enabled) {
    if (!values.accountName) throw invalidInput("accountName", "is needed before the method can be offered");
    if (!values.accountNumber) throw invalidInput("accountNumber", "is needed before the method can be offered");
    if (bank && !values.bankName) throw invalidInput("bankName", "is needed before bank transfer can be offered");
    if (!bank && !values.accountKind) throw invalidInput("accountKind", "is needed: choose merchant or personal");
    if (input.approved !== true) throw invalidInput("approval", "is required: confirm that this account may receive the store's payments");
  }
  return values;
}

/**
 * Saves one method at `expectedVersion` (0 before its first save). Turning it on records the Owner's approval of exactly
 * these details; any later save while it stays on needs the approval again. Turning it off removes it from checkout for
 * new orders; orders placed with it keep their own records.
 */
export async function savePaymentMethodOnce(db: Db, principal: Principal, key: string, input: PaymentMethodInput): Promise<Once<{ method: ManualMethod; version: number }>> {
  const user = assertPermission(principal, "settings:write");
  const values = validatePaymentMethod(input);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw invalidInput("version", "must be a whole number");
  const enabled = input.enabled === true;
  const request = { ...values, enabled, expectedVersion: input.expectedVersion };
  const stale = () => new DomainError("VERSION_CONFLICT", "This payment method changed after you opened it. Reload and try again.");
  return runOnce(
    db,
    { userId: user.userId, operation: "settings.payment-method", key, request },
    async (tx) => {
      const userId = actorFor(user).ref;
      const row = { ...values, enabled, approvedAt: enabled ? sql`now()` : null, approvedByUserId: enabled ? userId : null, updatedByUserId: userId };
      if (request.expectedVersion === 0) {
        const [inserted] = await tx.insert(paymentMethods).values(row).onConflictDoNothing().returning({ version: paymentMethods.version });
        if (!inserted) throw stale();
        return { method: values.method, version: inserted.version };
      }
      const [updated] = await tx
        .update(paymentMethods)
        .set({ ...row, version: sql`${paymentMethods.version} + 1`, updatedAt: sql`now()` })
        .where(sql`${paymentMethods.method} = ${values.method} and ${paymentMethods.version} = ${request.expectedVersion}`)
        .returning({ version: paymentMethods.version });
      if (!updated) throw stale();
      return { method: values.method, version: updated.version };
    },
    async (_tx, ref: { method: ManualMethod; version: number }) => ref,
  );
}
