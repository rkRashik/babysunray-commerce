import "server-only";
import { createHash } from "node:crypto";
import { desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/database";
import { catalogueImports, productCategories, products, variants } from "@/db/schema";
import { actorFor, assertPermission, type Principal } from "../auth/principal";
import { DomainError } from "../domain-error";
import { canonicalJson, type Once, runOnce, validateIdempotencyKey } from "../idempotency/service";
import { type FileFormat, readImportFile } from "./import-file";
import { buildPlan, type ImportIssue, type ImportPlan } from "./import-plan";
import { createProduct, createVariant, replaceMeasurements, updateProduct } from "./service";

// Bulk catalogue import (docs/operations/catalogue-import.md): create-only, all-or-nothing, Owner only
// (catalog:write). The preview reads the file and the database and changes nothing. The import reads the same
// file again, must arrive at exactly the preview's fingerprint (same plan, same categories at the same
// version, every slug and SKU still free), and then creates everything in one transaction through the normal
// catalogue services, once per idempotency key. Imported products are drafts; a fabric statement is never
// confirmed by an import; no stock is received (new SKUs start at zero).

export type CategoryState = Record<string, { id: string; version: number }>;
export type ImportPreview = {
  ok: boolean;
  format: FileFormat;
  fileSha256: string;
  /** What the import must reproduce exactly; null while there are errors. */
  fingerprint: string | null;
  plan: ImportPlan;
  issues: ImportIssue[];
  warnings: ImportIssue[];
  counts: { rows: number; emptyRows: number; rejectedRows: number; products: number; variants: number };
};

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const READ_ONLY = { isolationLevel: "repeatable read", accessMode: "read only" } as const;

/** Reads, validates and checks a file against the database (read-only). */
async function analyse(db: Db, bytes: Uint8Array): Promise<ImportPreview & { categories: CategoryState }> {
  const read = readImportFile(bytes);
  const built = buildPlan(read.header, read.rows, read.issues);
  const issues = [...built.issues];
  const plan = built.plan;
  const slugs = plan.products.map((p) => p.slug);
  const skus = plan.products.flatMap((p) => p.variants.map((v) => v.sku));
  const categorySlugs = [...new Set(plan.products.map((p) => p.categorySlug).filter((c): c is string => c !== null))];
  const categories: CategoryState = {};
  if (slugs.length) {
    const taken = await db.select({ slug: products.slug }).from(products).where(inArray(products.slug, slugs));
    for (const { slug } of taken) {
      const product = plan.products.find((p) => p.slug === slug)!;
      issues.push({ line: product.lines[0], column: "product_slug", code: "slug_taken", message: `A product with the slug ${slug} already exists. The import only creates new products.` });
    }
  }
  if (skus.length) {
    const taken = await db.select({ sku: variants.sku }).from(variants).where(inArray(variants.sku, skus));
    for (const { sku } of taken) {
      const variant = plan.products.flatMap((p) => p.variants).find((v) => v.sku === sku)!;
      issues.push({ line: variant.line, column: "sku", code: "sku_taken", message: `SKU ${sku} already exists. The import only creates new SKUs.` });
    }
  }
  if (categorySlugs.length) {
    const found = await db.select({ slug: productCategories.slug, id: productCategories.id, version: productCategories.version }).from(productCategories).where(inArray(productCategories.slug, categorySlugs));
    for (const c of found) categories[c.slug] = { id: c.id, version: c.version };
    for (const p of plan.products) {
      if (p.categorySlug && !categories[p.categorySlug]) {
        issues.push({ line: p.lines[0], column: "category_slug", code: "unknown_category", message: `There is no category with the slug ${p.categorySlug}. Create it under Categories first, or leave the cell empty.` });
      }
    }
  }
  const ok = issues.length === 0 && plan.products.length > 0;
  if (plan.products.length === 0 && issues.length === 0) issues.push({ line: null, column: null, code: "no_rows", message: "The file has no product rows." });
  const variantCount = plan.products.reduce((n, p) => n + p.variants.length, 0);
  return {
    ok,
    format: read.format,
    fileSha256: sha256(bytes),
    fingerprint: ok ? sha256(canonicalJson({ plan, categories })) : null,
    plan,
    categories,
    issues: issues.sort((a, b) => (a.line ?? 0) - (b.line ?? 0)),
    warnings: built.warnings,
    counts: { rows: read.rows.length, emptyRows: built.emptyRows, rejectedRows: built.rejectedRows, products: plan.products.length, variants: variantCount },
  };
}

/** The preview: everything the import would create, every problem by row and column. Writes nothing. */
export async function previewImport(db: Db, principal: Principal, bytes: Uint8Array): Promise<ImportPreview> {
  assertPermission(principal, "catalog:write");
  const { categories: _unused, ...preview } = await db.transaction((tx) => analyse(tx, bytes), READ_ONLY);
  void _unused;
  return preview;
}

export type ImportResult = {
  id: string;
  createdAt: Date;
  format: FileFormat;
  productsCreated: number;
  variantsCreated: number;
  products: { id: string; slug: string; nameEn: string | null; nameBn: string | null }[];
};

export async function getImport(db: Db, importId: string): Promise<ImportResult> {
  const [row] = await db.select().from(catalogueImports).where(eq(catalogueImports.id, importId));
  if (!row) throw new DomainError("INVALID_INPUT", "Import not found.");
  const ids = row.productIds as string[];
  const created = await db.select({ id: products.id, slug: products.slug, nameEn: products.nameEn, nameBn: products.nameBn }).from(products).where(inArray(products.id, ids));
  return {
    id: row.id,
    createdAt: row.createdAt,
    format: row.format,
    productsCreated: row.productsCreated,
    variantsCreated: row.variantsCreated,
    products: ids.map((id) => created.find((p) => p.id === id)!).filter(Boolean),
  };
}

export const listImports = (db: Db, limit = 10) => db.select().from(catalogueImports).orderBy(desc(catalogueImports.createdAt)).limit(limit);

/**
 * Imports a file previewed earlier. `fingerprint` is the preview's: if the file, a category or the catalogue
 * changed so that the result would differ, nothing is created (VERSION_CONFLICT, "preview again"). A retry with
 * the same key and file returns the first import; the same key with another file is refused.
 */
export async function importCatalogueOnce(
  db: Db,
  principal: Principal,
  idempotencyKey: string,
  input: { bytes: Uint8Array; fingerprint: string },
): Promise<Once<ImportResult>> {
  const user = assertPermission(principal, "catalog:write");
  const key = validateIdempotencyKey(idempotencyKey);
  if (typeof input.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(input.fingerprint)) throw new DomainError("INVALID_INPUT", "Preview the file before importing it.");
  const request = { fileSha256: sha256(input.bytes), fingerprint: input.fingerprint };
  return runOnce(
    db,
    { userId: user.userId, operation: "catalog.import", key, request },
    async (tx) => {
      const now = await analyse(tx, input.bytes);
      if (!now.ok) {
        throw new DomainError("VERSION_CONFLICT", "The file no longer imports cleanly (a slug, SKU or category changed since the preview). Nothing was imported. Preview it again.");
      }
      if (now.fingerprint !== request.fingerprint) {
        throw new DomainError("VERSION_CONFLICT", "The file or the catalogue changed since the preview. Nothing was imported. Preview it again.");
      }
      const actor = actorFor(user);
      const ids: string[] = [];
      let variantsCreated = 0;
      for (const p of now.plan.products) {
        const product = await createProduct(tx, { slug: p.slug, nameEn: p.nameEn, nameBn: p.nameBn, descriptionEn: p.descriptionEn, descriptionBn: p.descriptionBn });
        let version = product.version;
        const content = {
          fabricEn: p.fabricEn,
          fabricBn: p.fabricBn,
          careEn: p.careEn,
          careBn: p.careBn,
          sizeGuidanceEn: p.sizeGuidanceEn,
          sizeGuidanceBn: p.sizeGuidanceBn,
          categoryId: p.categorySlug ? now.categories[p.categorySlug].id : null,
          featured: p.featured,
        };
        if (Object.values(content).some((v) => v !== null && v !== false)) version = (await updateProduct(tx, product.id, version, content, actor)).version;
        for (const v of p.variants) {
          await createVariant(tx, { productId: product.id, sku: v.sku, size: v.size, colour: v.colour, pricePaisa: v.pricePaisa });
          variantsCreated += 1;
        }
        if (p.measurements.length) await replaceMeasurements(tx, product.id, version, p.measurements);
        ids.push(product.id);
      }
      const [row] = await tx
        .insert(catalogueImports)
        .values({ actorUserId: user.userId, format: now.format, fileSha256: request.fileSha256, productsCreated: ids.length, variantsCreated, productIds: ids })
        .returning({ id: catalogueImports.id });
      return { importId: row.id };
    },
    (db2, ref: { importId: string }) => getImport(db2, ref.importId),
  );
}
