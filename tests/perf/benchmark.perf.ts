import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Db } from "../../src/db/database";
import type { Principal } from "../../src/modules/auth/principal";
import { reviewProductOnce } from "../../src/modules/catalogue/operations";
import { preparationOverview } from "../../src/modules/catalogue/preparation";
import { contentDigest, reviewStates } from "../../src/modules/catalogue/review";
import { listProducts } from "../../src/modules/catalogue/service";
import { previewImport } from "../../src/modules/catalogue/import-service";
import { IMPORT_COLUMNS } from "../../src/modules/catalogue/import-plan";
import { createExport } from "../../src/modules/exports/service";
import { launchReadiness } from "../../src/modules/launch/readiness";
import { normalizeImage, renderWidth } from "../../src/modules/media/images";
import { placeGuestOrder } from "../../src/modules/orders/guest-checkout";
import { setDeliveryZoneOnce } from "../../src/modules/orders/operations";
import { listOrders } from "../../src/modules/orders/queries";
import { getDashboard } from "../../src/modules/reports/dashboard";
import { parseDateRange } from "../../src/modules/reports/dates";
import { getPeriodReport } from "../../src/modules/reports/summary";
import { getPreviewProduct, listPreviewProducts, previewFacets, quoteCart } from "../../src/modules/storefront/service";
import { clearAuthState, createTestAuth, createVerifiedOwner } from "../support/auth";
import { testImage } from "../support/images";
import { createTestDb } from "../support/test-database";

// Performance benchmark (Gate H.28) on fictional data in babysunray_test only: 5,000 draft products with three SKUs
// each, 20 categories, 30,000 size-chart rows and 20,000 orders over a year with their items and COD entries. Each
// scenario runs once to warm up, then five times; the median and the slowest are reported. EXPLAIN ANALYZE shows
// what PostgreSQL does for the heaviest reads. Times are observations on this machine with a local database, not a
// promise for any host. Run with `npm run perf:bench`; never against babysunray_dev. Results: test-results/perf-benchmark.json.

const PRODUCTS = 5_000;
const ORDERS = 20_000;
let db: Db;
let pool: Pool;
let owner: Principal;
const results: Record<string, { medianMs: number; maxMs: number; note?: string }> = {};

beforeAll(async () => {
  ({ db, pool } = await createTestDb(4));
  await clearAuthState(pool);
  ({ principal: owner } = await createVerifiedOwner(createTestAuth(db), db, pool, "perf-owner@example.test"));
  for (const [code, chargePaisa] of [["dhaka_city", 6_000], ["outside_dhaka", 12_000]] as const) {
    const { rows } = await pool.query<{ version: number }>("select version from delivery_zones where code = $1", [code]);
    await setDeliveryZoneOnce(db, owner, randomUUID(), { code, chargePaisa, active: true, expectedVersion: rows[0]?.version ?? null });
  }
  const t = Date.now();
  await pool.query(`insert into product_categories (slug, name_en, name_bn) select 'perf-cat-' || g, 'Perf category ' || g, 'পারফ ক্যাটাগরি ' || g from generate_series(1, 20) g`);
  await pool.query(
    `insert into products (slug, name_en, name_bn, description_en, description_bn, category_id, care_en, care_bn, featured, created_at)
     select 'perf-p-' || g, 'Perf Romper ' || g, 'পারফ রম্পার ' || g, 'A fictional product.', 'একটি কাল্পনিক পণ্য।',
            (select id from product_categories where slug = 'perf-cat-' || (g % 20 + 1)), 'Fictional care.', 'কাল্পনিক যত্ন।', g % 100 = 0,
            now() - make_interval(secs => ${PRODUCTS} - g)
       from generate_series(1, ${PRODUCTS}) g`,
  );
  await pool.query(
    `insert into variants (product_id, sku, size, colour, price_paisa)
     select p.id, 'PERF-' || substr(p.slug, 8) || '-' || v.n, v.size, case when v.n = 3 then 'Sand' else 'Ivory' end, 50000 + v.n * 2500
       from products p cross join (values (1, '0-3M'), (2, '3-6M'), (3, '6-12M')) as v(n, size) where p.slug like 'perf-p-%'`,
  );
  await pool.query(`insert into inventory_balances (variant_id, on_hand) select id, case when sku like '%-3' then 0 else 10 end from variants where sku like 'PERF-%'`);
  await pool.query(`insert into stock_movements (variant_id, movement_type, quantity_delta, actor_type, actor_ref) select id, 'receipt', 10, 'system', 'perf-seed' from variants where sku like 'PERF-%' and sku not like '%-3'`);
  await pool.query(
    `insert into product_measurements (product_id, size, point, value_mm)
     select p.id, s.size, pt.point, 300 + s.n * 20 from products p cross join (values (1, '0-3M'), (2, '3-6M'), (3, '6-12M')) as s(n, size)
       cross join (values ('chest'), ('length')) as pt(point) where p.slug like 'perf-p-%'`,
  );
  // Orders over the last year: 60 % delivered and closed with COD collected and settled, 20 % dispatched, 20 % cancelled.
  await pool.query(
    `with picked as (
       select g, v.id as variant_id, v.sku, v.size, v.colour, v.price_paisa, p.name_en, p.name_bn, now() - make_interval(mins => (g * 26)) as at
         from generate_series(1, ${ORDERS}) g
         join variants v on v.sku = 'PERF-' || (g % ${PRODUCTS} + 1) || '-1'
         join products p on p.id = v.product_id),
     made as (
       insert into orders (source, customer_name, customer_phone, delivery_address, delivery_zone, subtotal_paisa, delivery_charge_paisa, total_paisa,
                           order_status, fulfilment_status, payment_status, return_status, cod_collected_paisa, cod_settled_paisa,
                           verification_expires_at, confirmed_at, delivered_at, closed_at, created_by_user_id, created_at, updated_at)
       select case g % 3 when 0 then 'messenger' when 1 then 'whatsapp' else 'website' end, 'Perf Customer', '017110' || lpad((g % 100000)::text, 5, '0'),
              'House ' || g || ', Fictional Road', 'dhaka_city', price_paisa, 6000, price_paisa + 6000,
              case when g % 5 < 3 then 'closed' when g % 5 = 3 then 'confirmed' else 'cancelled' end,
              case when g % 5 < 3 then 'delivered' when g % 5 = 3 then 'dispatched' else 'unfulfilled' end,
              case when g % 5 < 3 then 'settled' else 'unpaid' end, 'none',
              case when g % 5 < 3 then price_paisa + 6000 else 0 end, case when g % 5 < 3 then price_paisa + 6000 else 0 end,
              at + interval '24 hours', case when g % 5 < 4 then at + interval '2 hours' end,
              case when g % 5 < 3 then at + interval '2 days' end, case when g % 5 < 3 then at + interval '10 days' when g % 5 = 4 then at + interval '1 hour' end,
              $1::uuid, at, at
         from picked
       returning id, created_at, total_paisa, order_status, subtotal_paisa)
     select count(*) from made`,
    [owner.userId],
  );
  await pool.query(
    `insert into order_items (order_id, variant_id, sku, product_name_en, product_name_bn, size, colour, unit_price_paisa, quantity, line_total_paisa)
     select o.id, v.id, v.sku, p.name_en, p.name_bn, v.size, v.colour, o.subtotal_paisa, 1, o.subtotal_paisa
       from orders o join variants v on v.price_paisa = o.subtotal_paisa and v.sku = (select 'PERF-' || ((o.number % ${PRODUCTS}) + 1) || '-1') join products p on p.id = v.product_id`,
  );
  await pool.query(
    `insert into payment_entries (order_id, kind, amount_paisa, occurred_on, actor_user_id)
     select id, k, total_paisa, (created_at + interval '3 days')::date, $1::uuid from orders cross join (values ('collected'), ('settled')) as kinds(k) where order_status = 'closed'`,
    [owner.userId],
  );
  await pool.query("analyze");
  results.seed = { medianMs: Date.now() - t, maxMs: Date.now() - t, note: `${PRODUCTS} products, ${PRODUCTS * 3} SKUs, ${ORDERS} orders` };
}, 900_000);

afterAll(async () => {
  // test-results/ is git-ignored; the file holds timings and query plans of fictional data only.
  mkdirSync("test-results", { recursive: true });
  writeFileSync("test-results/perf-benchmark.json", `${JSON.stringify({ benchmark: "catalogue-orders", database: "babysunray_test (fictional)", ranAt: new Date().toISOString(), results }, null, 1)}
`);
  await pool?.end();
});

async function measure<T>(name: string, run: () => Promise<T>, note?: string): Promise<T> {
  let value = await run();
  const times: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const t = performance.now();
    value = await run();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  results[name] = { medianMs: Math.round(times[2] * 10) / 10, maxMs: Math.round(times[4] * 10) / 10, ...(note ? { note } : {}) };
  return value;
}

async function explain(name: string, query: ReturnType<typeof sql>) {
  const { rows } = await db.execute<{ "QUERY PLAN": string }>(sql`explain (analyze, buffers) ${query}`);
  const plan = rows.map((r) => r["QUERY PLAN"]);
  results[`explain:${name}`] = { medianMs: Number(/Execution Time: ([0-9.]+)/.exec(plan.at(-1) ?? "")?.[1] ?? NaN), maxMs: NaN, note: plan.filter((l) => /Scan|Execution|Sort Method|Hash/.test(l)).slice(0, 8).map((l) => l.trim()).join(" | ") };
}

it("catalogue: Office list, search, filters, preparation and the storefront preview", async () => {
  const [{ id: categoryId }] = (await pool.query<{ id: string }>("select id from product_categories where slug = 'perf-cat-7'")).rows;
  expect((await measure("office.listProducts.firstPage", () => listProducts(db, { limit: 25 }))).items).toHaveLength(25);
  const deep = (await listProducts(db, { limit: 100 })).items.at(-1)!.key;
  await measure("office.listProducts.secondPage", () => listProducts(db, { limit: 25, after: deep }));
  expect((await measure("office.listProducts.search", () => listProducts(db, { limit: 25, q: "Romper 4999" }))).items.length).toBeGreaterThan(0);
  await measure("office.listProducts.searchSku", () => listProducts(db, { limit: 25, q: "PERF-4321" }));
  await measure("office.listProducts.category", () => listProducts(db, { limit: 25, categoryId }));
  await measure("office.listProducts.missingFabric", () => listProducts(db, { limit: 25, missing: "fabric" }));
  await measure("office.listProducts.inStock", () => listProducts(db, { limit: 25, stock: "in" }));
  await measure("office.preparationOverview", () => preparationOverview(db, owner));
  await measure("preview.list", () => listPreviewProducts(db, owner, {}));
  await measure("preview.list.page50", () => listPreviewProducts(db, owner, { page: 50 }));
  await measure("preview.list.search", () => listPreviewProducts(db, owner, { q: "রম্পার 4" }));
  await measure("preview.list.sizeInStock", () => listPreviewProducts(db, owner, { size: "3-6M", inStock: true }));
  await measure("preview.facets", () => previewFacets(db, owner));
  await measure("preview.product", () => getPreviewProduct(db, owner, "perf-p-2500"));
  const lines = Array.from({ length: 20 }, (_, i) => ({ sku: `PERF-${i * 200 + 1}-1`, quantity: 2 }));
  expect((await measure("preview.quoteCart.20lines", () => quoteCart(db, owner, { lines, zone: "dhaka_city" }))).ready).toBe(true);
  await explain("search.ilike", sql`select id from products where normalize(name_en, NFC) ilike '%romper 4999%' or normalize(name_bn, NFC) ilike '%romper 4999%' or slug ilike '%romper 4999%' order by created_at, id limit 26`);
  await explain("preview.list", sql`select p.id from products p where p.status = 'draft' and exists (select 1 from variants v where v.product_id = p.id and v.status = 'active') order by p.featured desc, p.created_at desc, p.id desc limit 25 offset 1200`);
});

it("reviews and launch readiness over every product", async () => {
  const ids = (await listProducts(db, { limit: 50 })).items.map((p) => p.id);
  const states = await measure("review.states.50", () => reviewStates(db, ids));
  for (const id of ids.slice(0, 10)) await reviewProductOnce(db, owner, randomUUID(), { productId: id, contentSha256: states.get(id)!.contentSha256 });
  const readiness = await measure("launch.readiness", () => launchReadiness(db, owner), "digest of every draft product's content, integrity checks");
  expect(readiness.gate.open).toBe(false);
  expect(readiness.sections.find((s) => s.id === "commerce")?.checks.find((c) => c.id === "integrity")?.status).toBe("ready");
  await explain("readiness.digests", sql`select count(*) filter (where (select r.content_sha256 from product_reviews r where r.product_id = ${sql`"products"`}.id order by r.created_at desc limit 1) = ${contentDigest()}) from products where status = 'draft'`);
});

it("orders: list pages, attention filter, dashboard, a year's report, guest submission", async () => {
  const first = await measure("orders.list.firstPage", () => listOrders(db, { limit: 25 }));
  expect(first.items).toHaveLength(25);
  let cursor = first.items.at(-1)!.key;
  for (let i = 0; i < 40; i += 1) cursor = (await listOrders(db, { limit: 100, after: cursor })).items.at(-1)!.key;
  await measure("orders.list.page4000", () => listOrders(db, { limit: 25, after: cursor }));
  await measure("orders.list.attention", () => listOrders(db, { limit: 25, attention: true }));
  await measure("orders.list.byNumber", () => listOrders(db, { limit: 25, number: "ORD-012345" }));
  await measure("reports.dashboard", () => getDashboard(db));
  const today = new Date().toISOString().slice(0, 10);
  const yearAgo = new Date(Date.now() - 364 * 86_400_000).toISOString().slice(0, 10);
  await measure("reports.period.365days", () => getPeriodReport(db, parseDateRange(yearAgo, today)));
  await explain("orders.attention", sql`select id from orders where order_status = 'verification_expired' or (order_status = 'pending_verification' and verification_expires_at <= now()) or exists (select 1 from cancellation_requests c where c.order_id = orders.id and c.status = 'open') order by created_at desc, id desc limit 26`);

  // One guest submission into the full catalogue (a reviewed product).
  const [{ id }] = (await pool.query<{ id: string }>("select id from products where slug = 'perf-p-77'")).rows;
  const state = (await reviewStates(db, [id])).get(id)!;
  await reviewProductOnce(db, owner, randomUUID(), { productId: id, contentSha256: state.contentSha256 });
  const request = () => ({ customer: { name: "Perf Guest", phone: "01711000777", address: "House 77, Fictional Road" }, deliveryZone: "dhaka_city", items: [{ sku: "PERF-77-1", quantity: 1, unitPricePaisa: 52_500 }], deliveryChargePaisa: 6_000, totalPaisa: 58_500 });
  const t = performance.now();
  expect((await placeGuestOrder(db, randomUUID(), request())).replayed).toBe(false);
  results["guest.placeOrder.single"] = { medianMs: Math.round((performance.now() - t) * 10) / 10, maxMs: NaN, note: "one submission, includes the overdue sweep" };
});

it("exports stream without holding the whole file, and bulk import previews 1,000 rows", async () => {
  let peak = 0;
  const run = async () => {
    const before = process.memoryUsage().heapUsed;
    const file = await createExport(db, owner, { dataset: "orders", format: "csv", filters: {} });
    let bytes = 0;
    for await (const chunk of file.chunks) {
      bytes += chunk.byteLength;
      peak = Math.max(peak, process.memoryUsage().heapUsed - before);
    }
    return bytes;
  };
  const bytes = await measure("exports.orders.csv.20000", run);
  results["exports.orders.csv.20000"].note = `${Math.round(bytes / 1024)} KiB written; heap growth at most ${Math.round(peak / 1024 / 1024)} MiB while streaming`;
  await measure("exports.orders.xlsx.20000", async () => {
    const file = await createExport(db, owner, { dataset: "orders", format: "xlsx", filters: {} });
    for await (const chunk of file.chunks) void chunk;
  });

  const header = IMPORT_COLUMNS.join(",");
  const rows = Array.from({ length: 1000 }, (_, i) => IMPORT_COLUMNS.map((c) => ({ product_slug: `perf-import-${i}`, name_en: `Import Romper ${i}`, name_bn: `ইমপোর্ট রম্পার ${i}`, sku: `PERF-IMP-${i}`, size: "0-3M", colour: "Ivory", price_bdt: "850" })[c as "sku"] ?? "").join(","));
  const preview = await measure("import.preview.1000rows", () => previewImport(db, owner, new TextEncoder().encode(`${header}\r\n${rows.join("\r\n")}\r\n`)));
  expect(preview.ok).toBe(true);
});

it("product photos: normalising a large upload and rendering a list-size copy", async () => {
  const big = await testImage("jpeg", 3000, 4000, { colour: 90 });
  const stored = await measure("media.normalize.3000x4000jpeg", () => normalizeImage(big));
  await measure("media.render.640", () => renderWidth(stored.data, stored.format, 640));
});
