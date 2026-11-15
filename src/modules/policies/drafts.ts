import "server-only";
import { createHash } from "node:crypto";
import { asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/database";
import { policyDraftEvents, policyDrafts } from "@/db/schema";
import { actorFor, assertPermission, type Principal } from "../auth/principal";
import { type UserActor, validateActor } from "../actor";
import { DomainError, invalidInput } from "../domain-error";
import { type Once, runOnce } from "../idempotency/service";

// Private drafts of the customer policies public checkout depends on (S-17, G-7). Owner only. The text is the
// Owner's: nothing is generated, translated or filled in, and it is only ever shown as plain text. A draft can be
// empty, drafted or reviewed (the Owner marked this exact version; any edit clears it). There is no published
// state and no publish action: a reviewed draft is not founder approval, not legal advice and not public.

export const POLICY_KINDS = ["delivery", "returns", "privacy", "checkout_notices"] as const;
export type PolicyKind = (typeof POLICY_KINDS)[number];
export const isPolicyKind = (value: unknown): value is PolicyKind => typeof value === "string" && (POLICY_KINDS as readonly string[]).includes(value);
export const POLICY_TITLES: Record<PolicyKind, string> = {
  delivery: "Delivery policy",
  returns: "Return and exchange policy",
  privacy: "Privacy policy",
  checkout_notices: "Checkout notices",
};
export const MAX_POLICY_LENGTH = 20_000;

export type PolicyStatus = "empty" | "drafted" | "reviewed";
export type PolicyDraft = {
  kind: PolicyKind;
  bodyEn: string | null;
  bodyBn: string | null;
  /** 0 before the first save. */
  version: number;
  status: PolicyStatus;
  updatedAt: Date | null;
  reviewedAt: Date | null;
};

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Plain text, trimmed; blank is null. Line breaks allowed; control characters and over-long text refused. */
function policyText(raw: unknown, field: string): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") throw invalidInput(field, "must be text");
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (text === "") return null;
  if (text.length > MAX_POLICY_LENGTH) throw invalidInput(field, `must be at most ${MAX_POLICY_LENGTH} characters`);
  if (CONTROL.test(text)) throw invalidInput(field, "contains characters that are not allowed");
  return text;
}

const digest = (text: string | null) => (text === null ? null : createHash("sha256").update(text).digest("hex"));
const statusOf = (row: { bodyEn: string | null; bodyBn: string | null; reviewedAt: Date | null }): PolicyStatus =>
  row.reviewedAt ? "reviewed" : row.bodyEn || row.bodyBn ? "drafted" : "empty";

/** Every kind, saved or not, in display order. */
export async function listPolicyDrafts(db: Db, principal: Principal): Promise<PolicyDraft[]> {
  assertPermission(principal, "policies:read");
  const rows = await db.select().from(policyDrafts);
  return POLICY_KINDS.map((kind) => {
    const row = rows.find((r) => r.kind === kind);
    if (!row) return { kind, bodyEn: null, bodyBn: null, version: 0, status: "empty", updatedAt: null, reviewedAt: null };
    return { kind, bodyEn: row.bodyEn, bodyBn: row.bodyBn, version: row.version, status: statusOf(row), updatedAt: row.updatedAt, reviewedAt: row.reviewedAt };
  });
}

/** The audit trail of one kind, newest first: who saved or marked which version, when, and the text digests. */
export async function policyHistory(db: Db, principal: Principal, kind: PolicyKind) {
  assertPermission(principal, "policies:read");
  return db.select().from(policyDraftEvents).where(eq(policyDraftEvents.kind, kind)).orderBy(desc(policyDraftEvents.id)).limit(50);
}

async function lockDraft(tx: Db, kind: PolicyKind) {
  const [row] = await tx.select().from(policyDrafts).where(eq(policyDrafts.kind, kind)).for("update");
  return row ?? null;
}

const stale = () => new DomainError("VERSION_CONFLICT", "This draft was changed after you opened it. Reload it, compare and save again.");

/**
 * Saves both languages of a draft if it is still at `expectedVersion` (0 for a kind never saved). Any change clears
 * an earlier "reviewed" mark; saving the same text changes nothing. Returns the version now stored.
 */
export async function savePolicyDraft(tx: Db, input: { kind: PolicyKind; expectedVersion: number; bodyEn: unknown; bodyBn: unknown }, actor: UserActor): Promise<{ kind: PolicyKind; version: number }> {
  const user = validateActor(actor);
  if (!isPolicyKind(input.kind)) throw invalidInput("kind", "is not a policy kind");
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw invalidInput("version", "must be a whole number");
  const bodyEn = policyText(input.bodyEn, "bodyEn");
  const bodyBn = policyText(input.bodyBn, "bodyBn");
  let row: typeof policyDrafts.$inferSelect;
  if (input.expectedVersion === 0) {
    if (bodyEn === null && bodyBn === null) throw invalidInput("bodyEn", "or bodyBn is required for a first save");
    // A concurrent first save of the same kind waits on the primary key, then finds it taken: stale, not a second row.
    const [inserted] = await tx.insert(policyDrafts).values({ kind: input.kind, bodyEn, bodyBn, updatedByUserId: user.ref }).onConflictDoNothing().returning();
    if (!inserted) throw stale();
    row = inserted;
  } else {
    const current = await lockDraft(tx, input.kind);
    if (!current || current.version !== input.expectedVersion) throw stale();
    if (current.bodyEn === bodyEn && current.bodyBn === bodyBn) return { kind: input.kind, version: current.version };
    [row] = await tx
      .update(policyDrafts)
      .set({ bodyEn, bodyBn, version: sql`${policyDrafts.version} + 1`, updatedAt: sql`now()`, updatedByUserId: user.ref, reviewedAt: null, reviewedByUserId: null })
      .where(eq(policyDrafts.kind, input.kind))
      .returning();
  }
  await tx.insert(policyDraftEvents).values({ kind: row.kind, event: "saved", version: row.version, bodyEnSha256: digest(bodyEn), bodyBnSha256: digest(bodyBn), actorUserId: user.ref });
  return { kind: row.kind, version: row.version };
}

/**
 * Marks the version the Owner read as reviewed. Both languages must be present (S-1). This records the Owner's own
 * review only: it is not founder approval of a public policy and publishes nothing.
 */
export async function markPolicyReviewed(tx: Db, input: { kind: PolicyKind; expectedVersion: number }, actor: UserActor): Promise<{ kind: PolicyKind; version: number }> {
  const user = validateActor(actor);
  if (!isPolicyKind(input.kind)) throw invalidInput("kind", "is not a policy kind");
  const current = await lockDraft(tx, input.kind);
  if (!current || current.version !== input.expectedVersion) throw stale();
  if (!current.bodyEn || !current.bodyBn) throw invalidInput("draft", "needs both English and Bangla text before it can be marked reviewed");
  if (current.reviewedAt) return { kind: current.kind, version: current.version };
  await tx.update(policyDrafts).set({ reviewedAt: sql`now()`, reviewedByUserId: user.ref }).where(eq(policyDrafts.kind, input.kind));
  await tx.insert(policyDraftEvents).values({ kind: current.kind, event: "marked_reviewed", version: current.version, bodyEnSha256: digest(current.bodyEn), bodyBnSha256: digest(current.bodyBn), actorUserId: user.ref });
  return { kind: current.kind, version: current.version };
}

const loadDraft = async (db: Db, ref: { kind: PolicyKind; version: number }) => {
  const [row] = await db.select().from(policyDrafts).where(eq(policyDrafts.kind, ref.kind));
  return { kind: ref.kind, version: row?.version ?? ref.version };
};

export async function savePolicyDraftOnce(db: Db, principal: Principal, key: string, input: { kind: PolicyKind; expectedVersion: number; bodyEn: string | null; bodyBn: string | null }): Promise<Once<{ kind: PolicyKind; version: number }>> {
  const user = assertPermission(principal, "policies:write");
  const request = { kind: input.kind, expectedVersion: input.expectedVersion, bodyEn: input.bodyEn, bodyBn: input.bodyBn };
  return runOnce(db, { userId: user.userId, operation: "policies.draft.save", key, request }, (tx) => savePolicyDraft(tx, request, actorFor(user)), loadDraft);
}

export async function markPolicyReviewedOnce(db: Db, principal: Principal, key: string, input: { kind: PolicyKind; expectedVersion: number }): Promise<Once<{ kind: PolicyKind; version: number }>> {
  const user = assertPermission(principal, "policies:write");
  const request = { kind: input.kind, expectedVersion: input.expectedVersion };
  return runOnce(db, { userId: user.userId, operation: "policies.draft.review", key, request }, (tx) => markPolicyReviewed(tx, request, actorFor(user)), loadDraft);
}

/** Policy drafts for export (D-8 "settings and policies"): every saved kind with its status, oldest kind first. */
export async function policyDraftRows(db: Db) {
  const rows = await db.select().from(policyDrafts).orderBy(asc(policyDrafts.kind));
  return rows.map((r) => ({ ...r, status: statusOf(r) }));
}
