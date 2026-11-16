import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../../src/db/database";
import { products } from "../../src/db/schema";
import { actorFor, type Principal } from "../../src/modules/auth/principal";
import { reviewProductOnce } from "../../src/modules/catalogue/operations";
import { type PublicationRule, publishProduct, withdrawProduct } from "../../src/modules/catalogue/publication";
import { reviewStates } from "../../src/modules/catalogue/review";

/**
 * A fictional publication rule for tests only (the founder-stated readiness items). It is neither the proposal in
 * storefront-launch-decisions.md nor an approval: the application itself has no approved rule.
 */
export const TEST_PUBLICATION_RULE: PublicationRule = { id: "test-rule", items: ["name", "description", "variant"] };

export const contentDigestOf = async (db: Db, productId: string) => (await reviewStates(db, [productId])).get(productId)!.contentSha256;

/** Records the Owner's review of the product's current content. */
export async function reviewNow(db: Db, owner: Principal, productId: string): Promise<void> {
  await reviewProductOnce(db, owner, randomUUID(), { productId, contentSha256: await contentDigestOf(db, productId) });
}

/** Reviews the current content and publishes it under `rule` (the test rule by default). */
export async function publishNow(db: Db, owner: Principal, productId: string, rule = TEST_PUBLICATION_RULE) {
  await reviewNow(db, owner, productId);
  const digest = await contentDigestOf(db, productId);
  return db.transaction((tx) => publishProduct(tx, productId, digest, rule, actorFor(owner)));
}

/** Withdraws a published product at its current version. */
export async function withdrawNow(db: Db, owner: Principal, productId: string) {
  const [{ version }] = await db.select({ version: products.version }).from(products).where(eq(products.id, productId));
  return db.transaction((tx) => withdrawProduct(tx, productId, version, actorFor(owner)));
}
