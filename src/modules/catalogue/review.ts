import "server-only";
import { desc, eq, type SQL, sql } from "drizzle-orm";
import type { Db } from "@/db/database";
import { productReviews, products } from "@/db/schema";
import type { UserActor } from "../actor";
import { validateActor } from "../actor";
import { DomainError } from "../domain-error";
import { evaluateReadiness } from "./readiness";
import { validateId } from "./rules";
import { getProductWithVariants } from "./service";

// Internal product review (Gate H.26). The Owner records that a draft product's current content was reviewed.
// A review never publishes a product and grants no public visibility: no publication rule (I-6) is approved and
// no publish action exists. Each review names the SHA-256 of the product's reviewable content; it is current only
// while the content still has that digest, so any later change to text, claims, measurements, photos or SKUs
// (price included) makes it outdated without any edit path having to remember to clear it.

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * The digest of what a review covers, for the product whose id is `productId` (SQL, one value per product). Text, the fabric
 * statement and whether it is confirmed, care and size guidance, category, every SKU with size, colour, price and
 * status, the size chart, and every photo (file digest, descriptions, position). Not covered: stock, the featured
 * flag and category names. Lists are ordered with the C collation, so the digest does not depend on the server's;
 * the inner aliases are prefixed cd_ so they never shadow the caller's own.
 */
// Always table-qualified: inside a select list Drizzle prints a column as a bare "id", which the subqueries would
// resolve to their own table.
export function contentDigest(productId: SQL = sql`${products}.id`): SQL<string> {
  return sql<string>`encode(sha256(convert_to(jsonb_build_array(
    (select jsonb_build_array(cd_p.slug, cd_p.name_en, cd_p.name_bn, cd_p.description_en, cd_p.description_bn, cd_p.category_id, cd_p.fabric_en,
       cd_p.fabric_bn, cd_p.fabric_confirmed_at is not null, cd_p.care_en, cd_p.care_bn, cd_p.size_guidance_en, cd_p.size_guidance_bn)
       from products cd_p where cd_p.id = ${productId}),
    (select coalesce(jsonb_agg(jsonb_build_array(cd_v.sku, cd_v.size, cd_v.colour, cd_v.price_paisa, cd_v.status) order by cd_v.sku collate "C"), '[]'::jsonb)
       from variants cd_v where cd_v.product_id = ${productId}),
    (select coalesce(jsonb_agg(jsonb_build_array(cd_m.size, cd_m.point, cd_m.value_mm) order by cd_m.size collate "C", cd_m.point collate "C"), '[]'::jsonb)
       from product_measurements cd_m where cd_m.product_id = ${productId}),
    (select coalesce(jsonb_agg(jsonb_build_array(cd_pm.sha256, cd_pm.alt_en, cd_pm.alt_bn, cd_pm.position) order by cd_pm.position, cd_pm.id), '[]'::jsonb)
       from product_media cd_pm where cd_pm.product_id = ${productId})
  )::text, 'UTF8')), 'hex')`;
}

export type ReviewState = {
  /** The latest review, if any. */
  reviewedAt: Date | null;
  reviewedByUserId: string | null;
  /** Readiness items that were not met when it was reviewed. */
  openItems: string[];
  /** True while the product's content still has the reviewed digest. */
  current: boolean;
  /** The digest of the content now (what a new review would record). */
  contentSha256: string;
};

/** The latest review of each product and whether it is still current. One query, whatever the number of products. */
export async function reviewStates(db: Db, productIds: string[]): Promise<Map<string, ReviewState>> {
  if (productIds.length === 0) return new Map();
  const rows = await db.execute<{ id: string; digest: string; reviewed_at: Date | string | null; reviewed_by: string | null; reviewed_digest: string | null; open_items: string[] | null }>(sql`
    select rp.id, ${contentDigest(sql`rp.id`)} as digest, r.created_at as reviewed_at, r.reviewed_by_user_id as reviewed_by,
           r.content_sha256 as reviewed_digest, r.open_items
      from ${products} rp
      left join lateral (select * from ${productReviews} r where r.product_id = rp.id order by r.created_at desc, r.id desc limit 1) r on true
     where rp.id in (${sql.join(productIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
  return new Map(
    rows.rows.map((r) => [
      r.id,
      {
        reviewedAt: r.reviewed_at === null ? null : new Date(r.reviewed_at),
        reviewedByUserId: r.reviewed_by,
        openItems: r.open_items ?? [],
        current: r.reviewed_digest !== null && r.reviewed_digest === r.digest,
        contentSha256: r.digest,
      },
    ]),
  );
}

/**
 * Records the Owner's review of a draft product's content as it is now. `expectedContentSha256` is the digest the
 * Owner's screen showed; if the content changed since (any field, SKU, price or photo), the review is refused with
 * VERSION_CONFLICT, so a review never covers something the Owner did not see. The founder-stated items of the
 * readiness checklist (bilingual name and description, an active priced SKU) must be met; the other items are
 * recorded as open. The product row is locked, so the content cannot change while the review is written.
 */
export async function recordProductReview(tx: Db, productId: string, expectedContentSha256: string, actor: UserActor): Promise<{ reviewId: string }> {
  const reviewer = validateActor(actor);
  if (typeof expectedContentSha256 !== "string" || !SHA256.test(expectedContentSha256)) throw new DomainError("INVALID_INPUT", "contentSha256 must be 64 lowercase hexadecimal characters.");
  const id = validateId(productId, "productId");
  const [locked] = await tx.select({ status: products.status, digest: contentDigest() }).from(products).where(eq(products.id, id)).for("update");
  if (!locked) throw new DomainError("PRODUCT_NOT_FOUND", "Product not found.");
  if (locked.status !== "draft") throw new DomainError("PRODUCT_NOT_REVIEWABLE", "An archived product cannot be reviewed.");
  if (locked.digest !== expectedContentSha256) {
    throw new DomainError("VERSION_CONFLICT", "This product changed after you loaded it. Reload it, check its content and review it again.");
  }
  const items = evaluateReadiness(await getProductWithVariants(tx, id));
  const missing = items.filter((i) => i.basis === "approved" && !i.met);
  if (missing.length) {
    throw new DomainError("PRODUCT_NOT_REVIEWABLE", `Complete these before reviewing: ${missing.map((i) => i.label.toLowerCase()).join("; ")}.`);
  }
  const [row] = await tx
    .insert(productReviews)
    .values({ productId: id, contentSha256: locked.digest, openItems: items.filter((i) => !i.met).map((i) => i.id), reviewedByUserId: reviewer.ref })
    .returning({ id: productReviews.id });
  return { reviewId: row.id };
}

/** Every review of one product, newest first (the audit trail shown on the product page). */
export function reviewHistory(db: Db, productId: string) {
  return db
    .select({ id: productReviews.id, createdAt: productReviews.createdAt, reviewedByUserId: productReviews.reviewedByUserId, contentSha256: productReviews.contentSha256, openItems: productReviews.openItems })
    .from(productReviews)
    .where(eq(productReviews.productId, validateId(productId, "productId")))
    .orderBy(desc(productReviews.createdAt), desc(productReviews.id));
}
