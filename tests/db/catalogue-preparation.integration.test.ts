import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/database";
import type { Principal } from "../../src/modules/auth/principal";
import { preparationOverview, readinessFlags } from "../../src/modules/catalogue/preparation";
import { evaluateReadiness, READINESS_ITEMS } from "../../src/modules/catalogue/readiness";
import { createCategory, createProduct, createVariant, deactivateVariant, getProductWithVariants, listProducts, replaceMeasurements, updateProduct } from "../../src/modules/catalogue/service";
import { receiveStock } from "../../src/modules/inventory/service";
import { clearAuthState, createTestAuth, createVerifiedOwner } from "../support/auth";
import { TEST_ACTOR } from "../support/fixtures";
import { createTestDb } from "../support/test-database";

// Catalogue preparation: the SQL form of the readiness checklist must agree with evaluateReadiness on real rows,
// and the product list filters must return exactly the matching products. Fictional products only.

let db: Db;
let pool: Pool;
let owner: Principal;
let ownerId: string;
const tag = `prep${Date.now().toString(36)}`;
const ids: Record<string, string> = {};

beforeAll(async () => {
  ({ db, pool } = await createTestDb(4));
  const auth = createTestAuth(db);
  await clearAuthState(pool);
  ({ principal: owner, userId: ownerId } = await createVerifiedOwner(auth, db, pool, "prep-owner@example.test"));
  const category = await createCategory(db, { slug: `${tag}-cat`, nameEn: "Fictional prep" });
  const make = async (name: string, data: { bn?: boolean; desc?: boolean; content?: boolean; confirm?: boolean; category?: boolean; skus?: [string | null, number][]; measure?: string[]; photo?: "alt" | "noalt"; inactive?: boolean }) => {
    const p = await createProduct(db, { slug: `${tag}-${name}`, nameEn: `Prep ${name}`, nameBn: data.bn ? "কাল্পনিক" : null, descriptionEn: data.desc ? "Fictional" : null, descriptionBn: data.desc ? "কাল্পনিক" : null });
    let version = p.version;
    if (data.content || data.category) {
      version = (
        await updateProduct(
          db,
          p.id,
          version,
          { ...(data.content ? { fabricEn: "Fictional", fabricBn: "কাল্পনিক", careEn: "Fictional", careBn: "কাল্পনিক" } : {}), ...(data.category ? { categoryId: category.id } : {}) },
        )
      ).version;
    }
    if (data.confirm) await pool.query("update products set fabric_confirmed_at = now(), fabric_confirmed_by_user_id = $2 where id = $1", [p.id, ownerId]);
    for (const [i, [size, stock]] of (data.skus ?? []).entries()) {
      const v = await createVariant(db, { productId: p.id, sku: `${tag}-${name}-${i}`.toUpperCase(), size, pricePaisa: 50_000 });
      if (stock) await receiveStock(db, { sku: v.sku, quantity: stock, actor: TEST_ACTOR });
      if (data.inactive) await deactivateVariant(db, v.id);
    }
    if (data.measure?.length) {
      version = (await getProductWithVariants(db, p.id)).version;
      await replaceMeasurements(db, p.id, version, data.measure.map((size) => ({ size, point: "chest", valueMm: 300 })));
    }
    if (data.photo) {
      await pool.query(
        "insert into product_media (product_id, storage_key, content_type, byte_size, width, height, sha256, alt_en, alt_bn, position, created_by_user_id) values ($1, md5($4) || '.png', 'image/png', 1, 400, 400, md5($4) || md5($4), 'Fictional', $2, 0, $3)",
        [p.id, data.photo === "alt" ? "কাল্পনিক" : null, ownerId, `${p.id}`],
      );
    }
    ids[name] = p.id;
  };
  await make("complete", { bn: true, desc: true, content: true, confirm: true, category: true, skus: [["0-3M", 2], ["3-6M", 0]], measure: ["0-3M", "3-6M"], photo: "alt" });
  await make("nobn", { desc: true, skus: [["0-3M", 1]], measure: ["0-3M"] });
  await make("unmeasured", { bn: true, skus: [["0-3M", 0], ["3-6M", 0]], measure: ["0-3M"], content: true });
  await make("noalt", { bn: true, skus: [[null, 1]], photo: "noalt" });
  await make("empty", {});
  await make("inactive", { bn: true, skus: [["0-3M", 3]], inactive: true, measure: ["0-3M"] });
});

afterAll(async () => {
  await pool?.end();
});

describe("readiness in SQL", () => {
  it("agrees with evaluateReadiness for every item of every product", async () => {
    const flags = await readinessFlags(db, Object.values(ids));
    for (const [name, id] of Object.entries(ids)) {
      const product = await getProductWithVariants(db, id);
      const expected = Object.fromEntries(evaluateReadiness(product).filter((i) => i.id !== "policies").map((i) => [i.id, i.met]));
      expect(flags.get(id), name).toEqual(expected);
    }
    expect(flags.get(ids.complete)).toEqual(Object.fromEntries(READINESS_ITEMS.map((i) => [i.id, true])));
  });

  it("counts drafts without each item consistently with the per-product flags", async () => {
    const overview = await preparationOverview(db, owner);
    const drafts = (await pool.query<{ id: string }>("select id from products where status = 'draft'")).rows.map((r) => r.id);
    const flags = await readinessFlags(db, drafts);
    expect(overview.drafts).toBe(drafts.length);
    for (const item of READINESS_ITEMS) expect(overview.unmet[item.id], item.id).toBe(drafts.filter((id) => !flags.get(id)![item.id]).length);
  });

  it("keeps the checklist labels in one place", () => {
    const fromFunction = evaluateReadiness({ nameEn: null, nameBn: null, descriptionEn: null, descriptionBn: null, fabricEn: null, fabricBn: null, fabricConfirmedAt: null, careEn: null, careBn: null, categoryId: null, variants: [], measurements: [], media: [] });
    for (const item of READINESS_ITEMS) expect(fromFunction.find((i) => i.id === item.id), item.id).toMatchObject({ basis: item.basis, source: item.source, label: item.label });
  });
});

describe("product list filters", () => {
  const names = async (options: Parameters<typeof listProducts>[1]) => {
    const page = await listProducts(db, { ...options, q: tag });
    return page.items.map((p) => p.slug.slice(tag.length + 1)).sort();
  };

  it("filters by what is missing, category and stock, and pages with the filters kept", async () => {
    expect(await names({ limit: 50, missing: "name" })).toEqual(["empty", "nobn"]);
    expect(await names({ limit: 50, missing: "measurements" })).toEqual(["empty", "inactive", "noalt", "unmeasured"]);
    expect(await names({ limit: 50, missing: "photo" })).toEqual(["empty", "inactive", "nobn", "unmeasured"]);
    expect(await names({ limit: 50, missing: "alt" })).toEqual(["empty", "inactive", "noalt", "nobn", "unmeasured"]);
    expect(await names({ limit: 50, missing: "fabric" })).toEqual(["empty", "inactive", "noalt", "nobn", "unmeasured"]);
    expect(await names({ limit: 50, categoryId: (await pool.query("select category_id from products where id = $1", [ids.complete])).rows[0].category_id })).toEqual(["complete"]);
    expect(await names({ limit: 50, stock: "in" })).toEqual(["complete", "noalt", "nobn"]);
    expect(await names({ limit: 50, stock: "out" })).toEqual(["empty", "inactive", "unmeasured"]);
    const first = await listProducts(db, { limit: 2, q: tag, missing: "photo" });
    const second = await listProducts(db, { limit: 2, q: tag, missing: "photo", after: first.items.at(-1)!.key });
    expect([...first.items, ...second.items].map((p) => p.slug.slice(tag.length + 1)).sort()).toEqual(["empty", "inactive", "nobn", "unmeasured"]);
  });

  it("leaves archived products out of a 'still missing' list unless the Archived status is chosen", async () => {
    await pool.query("update products set status = 'archived' where id = $1", [ids.empty]);
    try {
      expect(await names({ limit: 50, missing: "name" })).toEqual(["nobn"]);
      expect(await names({ limit: 50, missing: "name", status: "archived" })).toEqual(["empty"]);
      // Without a "missing" filter an archived product is still listed (the list shows every status unless one is chosen).
      expect(await names({ limit: 50 })).toContain("empty");
    } finally {
      await pool.query("update products set status = 'draft' where id = $1", [ids.empty]);
    }
  });

  it("finds a product by any of its SKUs", async () => {
    const page = await listProducts(db, { limit: 5, q: `${tag}-unmeasured-1` });
    expect(page.items.map((p) => p.id)).toEqual([ids.unmeasured]);
  });
});
