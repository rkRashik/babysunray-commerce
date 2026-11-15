import "server-only";
import type { Db } from "@/db/database";
import { actorFor, assertPermission, type Principal } from "../auth/principal";
import { getProductWithVariants, type ProductDetail } from "../catalogue/service";
import { type Once, runOnce, validateIdempotencyKey } from "../idempotency/service";
import { newStorageKey, normalizeImage, uploadDigest } from "./images";
import { type AltText, addPhoto, describePhoto, movePhoto, removePhoto } from "./service";
import { getMediaStore, type MediaStore } from "./storage";

// Photo operations for the Owner Office (catalog:write, once per idempotency key, ADR-0005). The order of work
// keeps files and records in step: a new file is written before its record; if the record is not committed
// (refused, failed, or a replay of an earlier upload) the new file is deleted again. A replaced or removed
// file is deleted only after its record is gone for good. A crash between the two steps can leave a file with
// no record; `npm run media:verify` reports such files (it never leaves a record without its file).

const loadProduct = (db: Db, ref: { productId: string }) => getProductWithVariants(db, ref.productId);

async function deleteQuietly(store: MediaStore, key: string): Promise<void> {
  try {
    await store.remove(key);
  } catch (error) {
    // The key is a random name, not personal data; the manifest check will list the file as unreferenced.
    console.error(JSON.stringify({ level: "error", event: "media_file_not_deleted", storageKey: key, errorName: error instanceof Error ? error.name : typeof error }));
  }
}

/** Validates, normalises and stores an uploaded photo for a draft product (optionally replacing one). */
export async function uploadPhotoOnce(
  db: Db,
  principal: Principal,
  idempotencyKey: string,
  input: { productId: string; expectedVersion: number; bytes: Buffer; replaceMediaId?: string | null } & AltText,
  store: MediaStore = getMediaStore(),
): Promise<Once<ProductDetail>> {
  const user = assertPermission(principal, "catalog:write");
  const key = validateIdempotencyKey(idempotencyKey);
  const image = await normalizeImage(input.bytes);
  const request = {
    productId: input.productId,
    expectedVersion: input.expectedVersion,
    upload: uploadDigest(input.bytes),
    altEn: input.altEn ?? null,
    altBn: input.altBn ?? null,
    replaceMediaId: input.replaceMediaId ?? null,
  };
  const storageKey = newStorageKey(image.extension);
  await store.put(storageKey, image.data);
  let replacedKey = null as string | null;
  let once: Once<ProductDetail>;
  try {
    once = await runOnce(
      db,
      { userId: user.userId, operation: "catalog.photo.upload", key, request },
      async (tx) => {
        const result = await addPhoto(tx, { ...request, image, storageKey }, actorFor(user));
        replacedKey = result.replacedKey;
        return { productId: request.productId, mediaId: result.mediaId };
      },
      loadProduct,
    );
  } catch (error) {
    await deleteQuietly(store, storageKey);
    throw error;
  }
  // A replay: the first request stored (and recorded) its own file; this copy is not needed.
  if (once.replayed) await deleteQuietly(store, storageKey);
  else if (replacedKey) await deleteQuietly(store, replacedKey);
  return once;
}

export async function describePhotoOnce(db: Db, principal: Principal, idempotencyKey: string, input: { productId: string; mediaId: string; expectedVersion: number } & AltText): Promise<Once<ProductDetail>> {
  const user = assertPermission(principal, "catalog:write");
  const request = { ...input, altEn: input.altEn ?? null, altBn: input.altBn ?? null };
  return runOnce(
    db,
    { userId: user.userId, operation: "catalog.photo.describe", key: idempotencyKey, request },
    async (tx) => {
      await describePhoto(tx, request);
      return { productId: request.productId };
    },
    loadProduct,
  );
}

export async function movePhotoOnce(db: Db, principal: Principal, idempotencyKey: string, input: { productId: string; mediaId: string; expectedVersion: number; direction: "up" | "down" | "first" }): Promise<Once<ProductDetail>> {
  const user = assertPermission(principal, "catalog:write");
  const request = { ...input };
  return runOnce(
    db,
    { userId: user.userId, operation: "catalog.photo.move", key: idempotencyKey, request },
    async (tx) => {
      await movePhoto(tx, request);
      return { productId: request.productId };
    },
    loadProduct,
  );
}

/** Removes a photo: the record first (committed), then its file. A replay deletes nothing more. */
export async function removePhotoOnce(
  db: Db,
  principal: Principal,
  idempotencyKey: string,
  input: { productId: string; mediaId: string; expectedVersion: number },
  store: MediaStore = getMediaStore(),
): Promise<Once<ProductDetail>> {
  const user = assertPermission(principal, "catalog:write");
  const request = { ...input };
  let removedKey = null as string | null;
  const once = await runOnce(
    db,
    { userId: user.userId, operation: "catalog.photo.remove", key: idempotencyKey, request },
    async (tx) => {
      removedKey = await removePhoto(tx, request);
      return { productId: request.productId };
    },
    loadProduct,
  );
  if (!once.replayed && removedKey) await deleteQuietly(store, removedKey);
  return once;
}
