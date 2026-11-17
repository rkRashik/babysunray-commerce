import "server-only";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/database";
import { productMedia, products } from "@/db/schema";
import { publishedProduct } from "../catalogue/visibility";

// Which photos a customer may be shown (Gate H.44): only those of a PUBLISHED product, by the same definition as the
// public catalogue (catalogue/visibility.ts). A file existing in storage never makes a photo public; the record's
// product must be published at the moment of the request. Unknown, malformed, draft, withdrawn and archived all
// give the same null, so the answer reveals nothing about products a customer cannot see.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PublicPhoto = Pick<typeof productMedia.$inferSelect, "id" | "storageKey" | "contentType" | "sha256" | "width">;

export async function findPublicPhoto(db: Db, mediaId: string): Promise<PublicPhoto | null> {
  if (!UUID.test(mediaId)) return null;
  const [row] = await db
    .select({ id: productMedia.id, storageKey: productMedia.storageKey, contentType: productMedia.contentType, sha256: productMedia.sha256, width: productMedia.width })
    .from(productMedia)
    .innerJoin(products, eq(products.id, productMedia.productId))
    .where(and(eq(productMedia.id, mediaId.toLowerCase()), publishedProduct));
  return row ?? null;
}
