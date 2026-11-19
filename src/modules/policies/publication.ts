import "server-only";
import { createHash } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import { type Db, pgErrorCode } from "@/db/database";
import { policyDrafts, policyPublications } from "@/db/schema";
import { type UserActor, validateActor } from "../actor";
import { actorFor, assertPermission, type Principal } from "../auth/principal";
import { DomainError, invalidInput } from "../domain-error";
import { type Once, runOnce } from "../idempotency/service";
import { isPolicyKind, POLICY_KINDS, type PolicyKind } from "./drafts";

// Publishing the customer policies (S-17, G-7; ADR-0011). The founder's approval is the act of publishing: only an Owner
// (policies:publish) can do it, only for a draft version the Owner marked reviewed, only with the explicit approval the
// form asks for, and the exact text of that version is copied into an append-only record with its digests, who and when.
// Customers see a kind's newest publication, never a draft; a withdrawal hides it again. Nothing is generated, translated
// or filled in: an unpublished kind is simply absent (no placeholder text is ever shown as a policy).

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export type PublishedPolicy = { kind: PolicyKind; bodyEn: string; bodyBn: string; draftVersion: number; publishedAt: Date };

/**
 * Every kind's newest record: what customers see now (published) or nothing (withdrawn or never published). On a database
 * where migration 0020 is not applied yet the table does not exist, and nothing can have been published: none.
 */
async function newestRecords(db: Db) {
  try {
    return await db.selectDistinctOn([policyPublications.kind]).from(policyPublications).orderBy(policyPublications.kind, desc(policyPublications.id));
  } catch (error) {
    if (pgErrorCode(error) === "42P01") return [];
    throw error;
  }
}

/** The policies customers see now, in display order. Public reads (no principal): only published text leaves here. */
export async function publishedPolicies(db: Db): Promise<PublishedPolicy[]> {
  const rows = await newestRecords(db);
  return POLICY_KINDS.flatMap((kind) => {
    const r = rows.find((x) => x.kind === kind);
    return r && r.event === "published" && r.bodyEn && r.bodyBn && r.draftVersion ? [{ kind, bodyEn: r.bodyEn, bodyBn: r.bodyBn, draftVersion: r.draftVersion, publishedAt: r.createdAt }] : [];
  });
}

export async function publishedPolicy(db: Db, kind: unknown): Promise<PublishedPolicy | null> {
  if (!isPolicyKind(kind)) return null;
  return (await publishedPolicies(db)).find((p) => p.kind === kind) ?? null;
}

/** Per kind: the published draft version and when, for Admin (null when not published now). */
export async function publicationStates(db: Db, principal: Principal): Promise<Record<PolicyKind, { draftVersion: number; publishedAt: Date } | null>> {
  assertPermission(principal, "policies:read");
  const published = await publishedPolicies(db);
  return Object.fromEntries(POLICY_KINDS.map((k) => [k, published.find((p) => p.kind === k) ?? null])) as Record<PolicyKind, { draftVersion: number; publishedAt: Date } | null>;
}

/** Publishes the reviewed draft at `expectedVersion`, in the caller's transaction. Needs `approved: true` (the founder's explicit approval). */
export async function publishPolicy(tx: Db, input: { kind: PolicyKind; expectedVersion: number; approved: boolean }, actor: UserActor): Promise<{ kind: PolicyKind; draftVersion: number }> {
  const user = validateActor(actor);
  if (user.type !== "user") throw new DomainError("INVALID_INPUT", "Only a signed-in user can publish a policy.");
  if (!isPolicyKind(input.kind)) throw invalidInput("kind", "is not a policy kind");
  if (input.approved !== true) throw invalidInput("approval", "is required: tick that you approve this exact wording for customers");
  const [draft] = await tx.select().from(policyDrafts).where(eq(policyDrafts.kind, input.kind)).for("update");
  if (!draft || draft.version !== input.expectedVersion) throw new DomainError("VERSION_CONFLICT", "This draft was changed after you opened it. Reload it, read it again and publish.");
  if (!draft.reviewedAt || !draft.bodyEn || !draft.bodyBn) throw invalidInput("draft", "must be marked reviewed, in English and Bangla, before it can be published");
  await tx.insert(policyPublications).values({
    kind: draft.kind,
    event: "published",
    draftVersion: draft.version,
    bodyEn: draft.bodyEn,
    bodyBn: draft.bodyBn,
    bodyEnSha256: digest(draft.bodyEn),
    bodyBnSha256: digest(draft.bodyBn),
    actorUserId: user.ref,
  });
  return { kind: draft.kind, draftVersion: draft.version };
}

/** Hides the kind from customers (a new record; the history stays). Refused when nothing is published. */
export async function withdrawPolicy(tx: Db, input: { kind: PolicyKind }, actor: UserActor): Promise<{ kind: PolicyKind }> {
  const user = validateActor(actor);
  if (user.type !== "user") throw new DomainError("INVALID_INPUT", "Only a signed-in user can withdraw a policy.");
  if (!isPolicyKind(input.kind)) throw invalidInput("kind", "is not a policy kind");
  // Serialise publications of this kind on the draft row, so two withdrawals cannot interleave with a publication.
  await tx.select({ kind: policyDrafts.kind }).from(policyDrafts).where(eq(policyDrafts.kind, input.kind)).for("update");
  const [newest] = await tx.select({ event: policyPublications.event }).from(policyPublications).where(eq(policyPublications.kind, input.kind)).orderBy(desc(policyPublications.id)).limit(1);
  if (newest?.event !== "published") throw invalidInput("kind", "is not published");
  await tx.insert(policyPublications).values({ kind: input.kind, event: "withdrawn", actorUserId: user.ref });
  return { kind: input.kind };
}

const loadPublished = async (db: Db, ref: { kind: PolicyKind }) => {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(policyPublications).where(eq(policyPublications.kind, ref.kind));
  return { kind: ref.kind, records: row?.n ?? 0 };
};
type Recorded = { kind: PolicyKind; records: number };

export async function publishPolicyOnce(db: Db, principal: Principal, key: string, input: { kind: PolicyKind; expectedVersion: number; approved: boolean }): Promise<Once<Recorded>> {
  const user = assertPermission(principal, "policies:publish");
  const request = { kind: input.kind, expectedVersion: input.expectedVersion, approved: input.approved };
  return runOnce(db, { userId: user.userId, operation: "policies.publish", key, request }, (tx) => publishPolicy(tx, request, actorFor(user)), loadPublished);
}

export async function withdrawPolicyOnce(db: Db, principal: Principal, key: string, input: { kind: PolicyKind }): Promise<Once<Recorded>> {
  const user = assertPermission(principal, "policies:publish");
  const request = { kind: input.kind };
  return runOnce(db, { userId: user.userId, operation: "policies.withdraw", key, request }, (tx) => withdrawPolicy(tx, request, actorFor(user)), loadPublished);
}
