import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/database";
import { productPublicationEvents, productReviews, products } from "@/db/schema";
import { type UserActor, validateActor } from "../actor";
import { actorFor, assertPermission, type Principal } from "../auth/principal";
import { DomainError } from "../domain-error";
import { type Once, runOnce } from "../idempotency/service";
import { publishPhotosToCdn, withdrawPhotosFromCdn } from "../media/cdn-sync";
import { evaluateReadiness, type PreparationItem, type ReadinessItem } from "./readiness";
import { contentDigest } from "./review";
import { validateId, validateVersion } from "./rules";
import { getProductWithVariants, type Product } from "./service";

// Product publication (Gate H.32): the state model and the mechanics, without a reachable way to publish.
//
//   draft ──publish──▶ published ──withdraw──▶ draft            (any state except published ──archive──▶ archived)
//
// "Internal review" (a current review, review.ts) and "publish-ready" (no blockers below) are derived, not stored.
// Publishing needs a founder-approved publication rule (requirement I-6). None is approved, so
// APPROVED_PUBLICATION_RULE is null, the only operation that publishes (operations.ts) always refuses, and no route,
// page or Server Action calls the services here (a unit test reads the imports). A configuration value cannot change
// this: approving a rule is a reviewed code change in a later gate. Tests publish fictional products with a rule of
// their own to prove the mechanics.
//
// A published product cannot be edited (every content change requires a draft), so what customers see is exactly
// what was reviewed, apart from SKUs the Owner deactivates (they stop being offered) and stock. Withdrawing returns
// it to draft; orders, stock and history are never touched by publication.

/** A founder-approved publication rule: the readiness items (readiness.ts) a product must meet. */
export type PublicationRule = Readonly<{ id: string; items: readonly PreparationItem[] }>;

/** Requirement I-6 is not approved, so no product can be published. Replacing null is a founder decision. */
export const APPROVED_PUBLICATION_RULE: PublicationRule | null = null;

/** Why a product cannot be published now. Stable codes: `no_approved_rule`, `not_draft`, `review_not_current`, `item:<id>`. */
export function publicationBlockers(input: { status: Product["status"]; items: ReadinessItem[]; reviewCurrent: boolean }, rule: PublicationRule | null): string[] {
  const blockers: string[] = [];
  if (rule === null) blockers.push("no_approved_rule");
  if (input.status !== "draft") blockers.push("not_draft");
  if (!input.reviewCurrent) blockers.push("review_not_current");
  // The founder-stated items always apply, whatever a rule lists; a rule can only add to them.
  const required = new Set<string>([...input.items.filter((i) => i.basis === "approved").map((i) => i.id), ...(rule?.items ?? [])]);
  for (const id of required) if (!input.items.find((i) => i.id === id)?.met) blockers.push(`item:${id}`);
  return blockers;
}

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Locks the product row, then reads its state and content digest in a second statement. The order matters: under
 * READ COMMITTED a statement reads the snapshot taken when it started, so a digest computed in the statement that
 * waited for the lock would miss a variant, measurement or photo change committed by the transaction it waited for
 * (those lock the product but do not update its row). After the lock, every content writer is blocked, and the
 * fresh statement sees everything they committed.
 */
async function lockWithDigest(tx: Db, productId: string) {
  const [exists] = await tx.select({ id: products.id }).from(products).where(eq(products.id, productId)).for("update");
  if (!exists) throw new DomainError("PRODUCT_NOT_FOUND", "Product not found.");
  const [locked] = await tx.select({ status: products.status, version: products.version, digest: contentDigest() }).from(products).where(eq(products.id, productId));
  return locked;
}

async function latestReviewDigest(tx: Db, productId: string): Promise<string | null> {
  const [review] = await tx
    .select({ digest: productReviews.contentSha256 })
    .from(productReviews)
    .where(eq(productReviews.productId, productId))
    .orderBy(desc(productReviews.createdAt), desc(productReviews.id))
    .limit(1);
  return review?.digest ?? null;
}

export type PublicationState = { status: Product["status"]; contentSha256: string; reviewCurrent: boolean; blockers: string[] };

/** What publishing a product would need now under the approved rule (none: `no_approved_rule` is always listed). */
export async function publicationState(db: Db, productId: string, rule: PublicationRule | null = APPROVED_PUBLICATION_RULE): Promise<PublicationState> {
  const id = validateId(productId, "productId");
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ status: products.status, digest: contentDigest() }).from(products).where(eq(products.id, id));
    if (!row) throw new DomainError("PRODUCT_NOT_FOUND", "Product not found.");
    const reviewCurrent = (await latestReviewDigest(tx, id)) === row.digest;
    const items = evaluateReadiness(await getProductWithVariants(tx, id));
    return { status: row.status, contentSha256: row.digest, reviewCurrent, blockers: publicationBlockers({ status: row.status, items, reviewCurrent }, rule) };
  });
}

/**
 * Publishes a draft product under `rule`, in the caller's transaction. `expectedContentSha256` is the content digest
 * the Owner's screen showed: a product that changed since is refused (VERSION_CONFLICT), so nothing is published
 * that the Owner did not see. The product row is locked first, and every content change locks it too, so the
 * content cannot change between the checks and the commit. Refused with PRODUCT_NOT_PUBLISHABLE (listing the
 * blockers) unless the product is a draft whose content has a current review and meets every item of the rule.
 */
export async function publishProduct(tx: Db, productId: string, expectedContentSha256: string, rule: PublicationRule, actor: UserActor): Promise<Product> {
  const user = validateActor(actor);
  if (user.type !== "user") throw new DomainError("INVALID_INPUT", "Only a signed-in user can publish a product.");
  if (typeof expectedContentSha256 !== "string" || !SHA256.test(expectedContentSha256)) throw new DomainError("INVALID_INPUT", "contentSha256 must be 64 lowercase hexadecimal characters.");
  const id = validateId(productId, "productId");
  const locked = await lockWithDigest(tx, id);
  if (locked.digest !== expectedContentSha256) throw new DomainError("VERSION_CONFLICT", "This product changed after you loaded it. Reload it, check it and try again.");
  const reviewCurrent = (await latestReviewDigest(tx, id)) === locked.digest;
  const blockers = publicationBlockers({ status: locked.status, items: evaluateReadiness(await getProductWithVariants(tx, id)), reviewCurrent }, rule);
  if (blockers.length) throw new DomainError("PRODUCT_NOT_PUBLISHABLE", `This product cannot be published: ${blockers.join(", ")}.`);
  const [published] = await tx
    .update(products)
    .set({ status: "published", version: sql`${products.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(products.id, id), eq(products.status, "draft")))
    .returning();
  if (!published) throw new Error("Product changed while it was being published.");
  await tx.insert(productPublicationEvents).values({ productId: id, event: "published", contentSha256: locked.digest, ruleId: rule.id, actorUserId: user.ref });
  return published;
}

/**
 * Withdraws a published product from the shop: it becomes a draft again (editable, invisible to customers). Orders,
 * stock and the publication history are kept. `expectedVersion` is the product version the Owner saw.
 */
export async function withdrawProduct(tx: Db, productId: string, expectedVersion: number, actor: UserActor): Promise<Product> {
  const user = validateActor(actor);
  if (user.type !== "user") throw new DomainError("INVALID_INPUT", "Only a signed-in user can withdraw a product.");
  const id = validateId(productId, "productId");
  const version = validateVersion(expectedVersion);
  const locked = await lockWithDigest(tx, id);
  if (locked.version !== version) throw new DomainError("VERSION_CONFLICT", "This product changed after you loaded it. Reload it and try again.");
  if (locked.status !== "published") throw new DomainError("PRODUCT_NOT_PUBLISHABLE", "Only a published product can be withdrawn.");
  const [withdrawn] = await tx
    .update(products)
    .set({ status: "draft", version: sql`${products.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(products.id, id), eq(products.status, "published")))
    .returning();
  if (!withdrawn) throw new Error("Product changed while it was being withdrawn.");
  await tx.insert(productPublicationEvents).values({ productId: id, event: "withdrawn", contentSha256: locked.digest, ruleId: null, actorUserId: user.ref });
  return withdrawn;
}

const loadProduct = async (tx: Db, ref: { productId: string }) => {
  const [product] = await tx.select().from(products).where(eq(products.id, ref.productId));
  return product;
};

/**
 * The one way to publish for any client, once per idempotency key (ADR-0005). It always refuses with
 * PUBLICATION_NOT_APPROVED while no rule is approved; nothing routes to it yet.
 */
export async function publishProductOnce(db: Db, principal: Principal, idempotencyKey: string, input: { productId: string; contentSha256: string }): Promise<Once<Product>> {
  const user = assertPermission(principal, "catalog:publish");
  const rule = APPROVED_PUBLICATION_RULE;
  if (rule === null) throw new DomainError("PUBLICATION_NOT_APPROVED", "No publication rule is approved (requirement I-6), so no product can be published.");
  const request = { productId: input.productId, contentSha256: input.contentSha256 };
  const once = await runOnce(
    db,
    { userId: user.userId, operation: "catalog.product.publish", key: idempotencyKey, request },
    async (tx) => ({ productId: (await publishProduct(tx, request.productId, request.contentSha256, rule, actorFor(user))).id }),
    loadProduct,
  );
  // After the commit, never inside the transaction: the CDN copies of the photos (media/cdn-sync.ts). It never throws; what
  // fails is retried by the maintenance job, and until then the photos are served without the CDN.
  if (!once.replayed) await publishPhotosToCdn(db, request.productId);
  return once;
}

/** Withdraws a published product, once per idempotency key. Nothing routes to it yet (nothing can be published). */
export async function withdrawProductOnce(db: Db, principal: Principal, idempotencyKey: string, input: { productId: string; expectedVersion: number }): Promise<Once<Product>> {
  const user = assertPermission(principal, "catalog:publish");
  const request = { productId: input.productId, expectedVersion: input.expectedVersion };
  const once = await runOnce(
    db,
    { userId: user.userId, operation: "catalog.product.withdraw", key: idempotencyKey, request },
    async (tx) => ({ productId: (await withdrawProduct(tx, request.productId, request.expectedVersion, actorFor(user))).id }),
    loadProduct,
  );
  // After the commit the shop no longer shows the photos (the database decides); now their CDN copies are destroyed and purged.
  if (!once.replayed) await withdrawPhotosFromCdn(db, request.productId);
  return once;
}

/** The publication history of one product, newest first. */
export function publicationHistory(db: Db, productId: string) {
  return db
    .select()
    .from(productPublicationEvents)
    .where(eq(productPublicationEvents.productId, validateId(productId, "productId")))
    .orderBy(desc(productPublicationEvents.id));
}
