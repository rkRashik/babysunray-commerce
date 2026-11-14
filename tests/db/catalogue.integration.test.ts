import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/database";
import {
  archiveProduct,
  createProduct,
  createVariant,
  deactivateVariant,
} from "../../src/modules/catalogue/service";
import { getStockLevel } from "../../src/modules/inventory/service";
import { createTestVariant, errorCodeOf, withFailingInserts } from "../support/fixtures";
import { createTestDb } from "../support/test-database";

let db: Db;
let pool: Pool;

beforeAll(async () => {
  ({ db, pool } = await createTestDb());
});

afterAll(async () => {
  await pool?.end();
});

describe("products", () => {
  it("creates an incomplete bilingual draft", async () => {
    const product = await createProduct(db, { slug: "cat-draft-1", nameBn: "  সুতির রম্পার  " });
    expect(product).toMatchObject({ slug: "cat-draft-1", nameBn: "সুতির রম্পার", nameEn: null, status: "draft" });
    expect(product.createdAt).toBeInstanceOf(Date);
  });

  it("requires a name in at least one language, in the service and in the database", async () => {
    expect(await errorCodeOf(createProduct(db, { slug: "cat-no-name", nameEn: "  " }))).toBe("INVALID_INPUT");
    expect(await errorCodeOf(pool.query("insert into products (slug) values ('cat-no-name')"))).toBe("23514");
  });

  it("rejects a duplicate slug", async () => {
    await createProduct(db, { slug: "cat-dup", nameEn: "Test Bib" });
    expect(await errorCodeOf(createProduct(db, { slug: "cat-dup", nameEn: "Other" }))).toBe("SLUG_TAKEN");
  });

  it("rejects an invalid slug and blank names at the database level", async () => {
    expect(await errorCodeOf(pool.query("insert into products (slug, name_en) values ('Bad Slug', 'x')"))).toBe("23514");
    expect(await errorCodeOf(pool.query("insert into products (slug, name_en) values ('cat-blank', ' ')"))).toBe("23514");
  });

  it("only allows draft and archived, so no product can become sellable yet", async () => {
    expect(
      await errorCodeOf(pool.query("insert into products (slug, name_en, status) values ('cat-pub', 'x', 'published')")),
    ).toBe("23514");
  });

  it("archives instead of deleting, and a product with variants cannot be deleted", async () => {
    const { product } = await createTestVariant(db, "cat");
    const archived = await archiveProduct(db, product.id);
    expect(archived.status).toBe("archived");
    expect(archived.updatedAt.getTime()).toBeGreaterThanOrEqual(product.updatedAt.getTime());
    // ON DELETE RESTRICT reports restrict_violation (23001).
    expect(await errorCodeOf(pool.query("delete from products where id = $1", [product.id]))).toBe("23001");
    expect(await errorCodeOf(archiveProduct(db, randomUUID()))).toBe("PRODUCT_NOT_FOUND");
  });
});

describe("variants", () => {
  it("stores the canonical SKU and creates a zero balance", async () => {
    const product = await createProduct(db, { slug: "cat-sku-norm", nameEn: "Test Romper" });
    const variant = await createVariant(db, {
      productId: product.id,
      sku: "  cat-norm-01 ",
      size: "6-12M",
      colour: "Sage",
      pricePaisa: 120_000,
    });
    expect(variant).toMatchObject({ sku: "CAT-NORM-01", pricePaisa: 120_000, status: "active", size: "6-12M" });
    expect(await getStockLevel(db, "cat-norm-01")).toEqual({ variantId: variant.id, onHand: 0 });
  });

  it("rejects duplicate SKUs that differ only in case or surrounding whitespace", async () => {
    const product = await createProduct(db, { slug: "cat-sku-dup", nameEn: "Test Romper" });
    await createVariant(db, { productId: product.id, sku: "CAT-DUP-01", pricePaisa: 50_000 });
    for (const sku of ["cat-dup-01", "  Cat-Dup-01  "]) {
      expect(await errorCodeOf(createVariant(db, { productId: product.id, sku, pricePaisa: 50_000 }))).toBe("SKU_TAKEN");
    }
  });

  it("stores only canonical SKUs at the database level", async () => {
    const product = await createProduct(db, { slug: "cat-sku-db", nameEn: "Test Romper" });
    for (const sku of ["cat-lower", " CAT-SPACE", ""]) {
      expect(
        await errorCodeOf(
          pool.query("insert into variants (product_id, sku, price_paisa) values ($1, $2, 100)", [product.id, sku]),
        ),
      ).toBe("23514");
    }
  });

  it("requires an existing product", async () => {
    expect(await errorCodeOf(createVariant(db, { productId: randomUUID(), sku: "CAT-ORPHAN", pricePaisa: 100 }))).toBe(
      "PRODUCT_NOT_FOUND",
    );
    expect(
      await errorCodeOf(
        pool.query("insert into variants (product_id, sku, price_paisa) values ($1, 'CAT-ORPHAN', 100)", [randomUUID()]),
      ),
    ).toBe("23503");
    expect(await errorCodeOf(pool.query("insert into inventory_balances (variant_id) values ($1)", [randomUUID()]))).toBe(
      "23503",
    );
  });

  it("enforces price bounds in the service and in the database", async () => {
    const product = await createProduct(db, { slug: "cat-price", nameEn: "Test Romper" });
    for (const pricePaisa of [0, -1, 99.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(await errorCodeOf(createVariant(db, { productId: product.id, sku: "CAT-PRICE", pricePaisa }))).toBe(
        "INVALID_INPUT",
      );
    }
    for (const price of ["0", "-1", "9007199254740992"]) {
      expect(
        await errorCodeOf(
          pool.query("insert into variants (product_id, sku, price_paisa) values ($1, 'CAT-PRICE', $2)", [product.id, price]),
        ),
      ).toBe("23514");
    }
    const max = await createVariant(db, { productId: product.id, sku: "CAT-PRICE-MAX", pricePaisa: Number.MAX_SAFE_INTEGER });
    expect(max.pricePaisa).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("creates the variant and its balance atomically", async () => {
    const product = await createProduct(db, { slug: "cat-atomic", nameEn: "Test Romper" });
    await expect(
      withFailingInserts(pool, "inventory_balances", () =>
        createVariant(db, { productId: product.id, sku: "CAT-ATOMIC", pricePaisa: 100 }),
      ),
    ).rejects.toThrow();
    const { rows } = await pool.query("select count(*)::int as n from variants where sku = 'CAT-ATOMIC'");
    expect(rows[0].n).toBe(0);
  });

  it("deactivates instead of deleting, and a variant with stock records cannot be deleted", async () => {
    const { variant } = await createTestVariant(db, "cat");
    expect((await deactivateVariant(db, variant.id)).status).toBe("inactive");
    expect(await errorCodeOf(pool.query("delete from variants where id = $1", [variant.id]))).toBe("23001");
    expect(await errorCodeOf(deactivateVariant(db, randomUUID()))).toBe("VARIANT_NOT_FOUND");
  });
});
