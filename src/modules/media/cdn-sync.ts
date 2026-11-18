import "server-only";
import { and, eq, isNotNull, isNull, ne, type SQL } from "drizzle-orm";
import type { Db } from "@/db/database";
import { productMedia, products } from "@/db/schema";
import { type CdnClient, type CdnConfig, cdnClient, cdnConfig, cdnPublicId } from "./cdn";
import { getMediaStore } from "./provider";
import type { MediaStore } from "./storage";

// Keeps the Cloudinary copies (cdn.ts) in step with publication (Gate H.57, ADR-0010). The database decides what is
// public: a CDN URL is built only for a published product's photo that has a recorded copy (storefront/public-catalogue.ts),
// so withdrawing a product stops its URLs at once, whatever Cloudinary is doing. These functions then make Cloudinary
// agree, and are safe to repeat: the public id is deterministic, an upload of an existing id is a no-op, a destroy of a
// missing one is success, and every database update names the value it expects. A copy is destroyed only while its
// product is NOT published, and a photo that still has a copy cannot be replaced or removed (media/service.ts), so a
// failed destroy can never leave an orphan nobody can find: the record stays, and `reconcileCdn` retries it.

export type CdnDeps = { config: CdnConfig; client: CdnClient; store: () => MediaStore };
export type CdnSyncResult = { uploaded: number; destroyed: number; failed: number };
const NONE: CdnSyncResult = { uploaded: 0, destroyed: 0, failed: 0 };

/** The configured CDN, or null when no CLOUDINARY_* setting is present (or the settings are invalid: nothing is sent). */
export function defaultCdnDeps(env: Record<string, string | undefined> = process.env): CdnDeps | null {
  const configured = cdnConfig(env);
  if (!configured.ok || !configured.config) return null;
  return { config: configured.config, client: cdnClient(configured.config), store: getMediaStore };
}

const log = (event: string, error: unknown) => console.error(JSON.stringify({ level: "error", event, errorName: error instanceof Error ? error.name : typeof error }));

type Row = { id: string; productId: string; storageKey: string; contentType: string; sha256: string; cdnPublicId: string | null };
const columns = { id: productMedia.id, productId: productMedia.productId, storageKey: productMedia.storageKey, contentType: productMedia.contentType, sha256: productMedia.sha256, cdnPublicId: productMedia.cdnPublicId };

/** Uploads one photo's copy and records it; if the product was withdrawn meanwhile the copy is destroyed again at once. */
async function copyUp(db: Db, deps: CdnDeps, row: Row): Promise<void> {
  const data = await deps.store().read(row.storageKey);
  if (!data) throw new Error("The stored photo is missing.");
  const publicId = cdnPublicId(deps.config, row);
  await deps.client.upload(publicId, data, row.contentType);
  const recorded = await db.update(productMedia).set({ cdnPublicId: publicId }).where(and(eq(productMedia.id, row.id), isNull(productMedia.cdnPublicId))).returning({ id: productMedia.id });
  if (recorded.length === 0) return;
  const [product] = await db.select({ status: products.status }).from(products).where(eq(products.id, row.productId));
  if (product?.status !== "published") await copyDown(db, deps, { ...row, cdnPublicId: publicId });
}

/** Destroys one photo's copy (with invalidation) and clears the record. Never called for a published product's photo. */
async function copyDown(db: Db, deps: CdnDeps, row: Row & { cdnPublicId: string }): Promise<void> {
  await deps.client.destroy(row.cdnPublicId);
  await db.update(productMedia).set({ cdnPublicId: null }).where(and(eq(productMedia.id, row.id), eq(productMedia.cdnPublicId, row.cdnPublicId)));
}

async function run(rows: Row[], work: (row: Row) => Promise<void>, kind: "uploaded" | "destroyed", result: CdnSyncResult): Promise<void> {
  for (const row of rows) {
    try {
      await work(row);
      result[kind] += 1;
    } catch (error) {
      result.failed += 1;
      log(kind === "uploaded" ? "cdn_upload_failed" : "cdn_destroy_failed", error);
    }
  }
}

const toUpload = (db: Db, where: SQL, limit: number) =>
  db.select(columns).from(productMedia).innerJoin(products, eq(products.id, productMedia.productId)).where(and(where, eq(products.status, "published"), isNull(productMedia.cdnPublicId))).limit(limit);
const toDestroy = (db: Db, where: SQL, limit: number) =>
  db.select(columns).from(productMedia).innerJoin(products, eq(products.id, productMedia.productId)).where(and(where, ne(products.status, "published"), isNotNull(productMedia.cdnPublicId))).limit(limit);

/** After a product is published: copies its photos to the CDN. Failures are counted and logged, never thrown. */
export async function publishPhotosToCdn(db: Db, productId: string, deps: CdnDeps | null = defaultCdnDeps()): Promise<CdnSyncResult> {
  if (!deps) return { ...NONE };
  const result = { ...NONE };
  await run(await toUpload(db, eq(productMedia.productId, productId), 50), (row) => copyUp(db, deps, row), "uploaded", result);
  return result;
}

/** After a product is withdrawn (or whenever it is not published): removes its photos' copies and purges the CDN. */
export async function withdrawPhotosFromCdn(db: Db, productId: string, deps: CdnDeps | null = defaultCdnDeps()): Promise<CdnSyncResult> {
  if (!deps) return { ...NONE };
  const result = { ...NONE };
  await run(await toDestroy(db, eq(productMedia.productId, productId), 50), (row) => copyDown(db, deps, row as Row & { cdnPublicId: string }), "destroyed", result);
  return result;
}

/** Retries whatever the two functions above left undone, across all products (a maintenance job). Removal goes first. */
export async function reconcileCdn(db: Db, deps: CdnDeps | null = defaultCdnDeps(), limit = 20): Promise<CdnSyncResult> {
  if (!deps) return { ...NONE };
  const result = { ...NONE };
  const any = isNotNull(productMedia.id);
  await run(await toDestroy(db, any, limit), (row) => copyDown(db, deps, row as Row & { cdnPublicId: string }), "destroyed", result);
  await run(await toUpload(db, any, limit), (row) => copyUp(db, deps, row), "uploaded", result);
  return result;
}
