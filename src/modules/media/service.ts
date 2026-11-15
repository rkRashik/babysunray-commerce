import "server-only";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@/db/database";
import { productMedia } from "@/db/schema";
import type { UserActor } from "../actor";
import { optionalText, validateId } from "../catalogue/rules";
import { bumpProductVersion, lockDraftProduct } from "../catalogue/service";
import { DomainError, invalidInput } from "../domain-error";
import type { StoredImage } from "./images";

// Photo metadata (the manifest rows) of draft products. Every change locks the product row and names the
// product version the client saw, so two tabs never silently overwrite each other; each change adds one to
// the product's version. Positions stay 0..n-1. Files are handled by the caller (operations.ts): it writes a
// new file before these run and deletes a replaced or removed file only after they commit.

/** Technical bound per product, not a merchandising rule (how many photos a product needs is not decided). */
export const MAX_PRODUCT_PHOTOS = 12;

export type AltText = { altEn?: string | null; altBn?: string | null };
const alt = (input: AltText) => ({ altEn: optionalText(input.altEn, "altEn", 300), altBn: optionalText(input.altBn, "altBn", 300) });

const photosOf = (tx: Db, productId: string) => tx.select().from(productMedia).where(eq(productMedia.productId, productId)).orderBy(asc(productMedia.position), asc(productMedia.createdAt));

async function photoOf(tx: Db, productId: string, mediaId: string) {
  const [row] = await tx.select().from(productMedia).where(and(eq(productMedia.id, validateId(mediaId, "mediaId")), eq(productMedia.productId, productId)));
  if (!row) throw new DomainError("MEDIA_NOT_FOUND", "Photo not found.");
  return row;
}

async function renumber(tx: Db, ids: string[]): Promise<void> {
  for (const [position, id] of ids.entries()) await tx.update(productMedia).set({ position }).where(eq(productMedia.id, id));
}

/**
 * Records a stored photo for a draft product: at the end, or in place of `replaceMediaId` (which keeps the
 * position and, unless new text is given, the alt text). Returns the new id and the replaced photo's key.
 */
export async function addPhoto(
  tx: Db,
  input: { productId: string; expectedVersion: number; image: StoredImage; storageKey: string; replaceMediaId?: string | null } & AltText,
  actor: UserActor,
): Promise<{ mediaId: string; replacedKey: string | null }> {
  const product = await lockDraftProduct(tx, input.productId, input.expectedVersion);
  const existing = await photosOf(tx, product.id);
  let position = existing.length;
  let replaced: (typeof existing)[number] | null = null;
  if (input.replaceMediaId) {
    replaced = await photoOf(tx, product.id, input.replaceMediaId);
    position = replaced.position;
    await tx.delete(productMedia).where(eq(productMedia.id, replaced.id));
  } else if (existing.length >= MAX_PRODUCT_PHOTOS) {
    throw invalidInput("photos", `can be at most ${MAX_PRODUCT_PHOTOS} per product`);
  }
  const text = alt(input);
  const [row] = await tx
    .insert(productMedia)
    .values({
      productId: product.id,
      storageKey: input.storageKey,
      contentType: input.image.contentType,
      byteSize: input.image.data.length,
      width: input.image.width,
      height: input.image.height,
      sha256: input.image.sha256,
      altEn: text.altEn ?? (replaced ? replaced.altEn : null),
      altBn: text.altBn ?? (replaced ? replaced.altBn : null),
      position,
      createdByUserId: actor.ref,
    })
    .returning({ id: productMedia.id });
  await bumpProductVersion(tx, product.id);
  return { mediaId: row.id, replacedKey: replaced?.storageKey ?? null };
}

/** Sets both alt texts of a photo (a blank one clears it). */
export async function describePhoto(tx: Db, input: { productId: string; mediaId: string; expectedVersion: number } & AltText): Promise<void> {
  const product = await lockDraftProduct(tx, input.productId, input.expectedVersion);
  const photo = await photoOf(tx, product.id, input.mediaId);
  await tx.update(productMedia).set({ ...alt(input), updatedAt: new Date() }).where(eq(productMedia.id, photo.id));
  await bumpProductVersion(tx, product.id);
}

/** Moves a photo one place up or down, or to the front (the first photo is the one lists show). */
export async function movePhoto(tx: Db, input: { productId: string; mediaId: string; expectedVersion: number; direction: "up" | "down" | "first" }): Promise<void> {
  if (!["up", "down", "first"].includes(input.direction)) throw invalidInput("direction", "must be up, down or first");
  const product = await lockDraftProduct(tx, input.productId, input.expectedVersion);
  const photo = await photoOf(tx, product.id, input.mediaId);
  const ids = (await photosOf(tx, product.id)).map((p) => p.id);
  const from = ids.indexOf(photo.id);
  const to = input.direction === "first" ? 0 : input.direction === "up" ? Math.max(0, from - 1) : Math.min(ids.length - 1, from + 1);
  ids.splice(to, 0, ...ids.splice(from, 1));
  await renumber(tx, ids);
  await bumpProductVersion(tx, product.id);
}

/** Removes a photo's record and closes the gap; returns its storage key so the caller can delete the file. */
export async function removePhoto(tx: Db, input: { productId: string; mediaId: string; expectedVersion: number }): Promise<string> {
  const product = await lockDraftProduct(tx, input.productId, input.expectedVersion);
  const photo = await photoOf(tx, product.id, input.mediaId);
  await tx.delete(productMedia).where(eq(productMedia.id, photo.id));
  await renumber(tx, (await photosOf(tx, product.id)).map((p) => p.id));
  await bumpProductVersion(tx, product.id);
  return photo.storageKey;
}

/** One photo's record, for serving it; MEDIA_NOT_FOUND for an unknown or malformed id. */
export async function getPhoto(db: Db, mediaId: string): Promise<typeof productMedia.$inferSelect> {
  const id = (() => {
    try {
      return validateId(mediaId, "mediaId");
    } catch {
      throw new DomainError("MEDIA_NOT_FOUND", "Photo not found.");
    }
  })();
  const [row] = await db.select().from(productMedia).where(eq(productMedia.id, id));
  if (!row) throw new DomainError("MEDIA_NOT_FOUND", "Photo not found.");
  return row;
}
