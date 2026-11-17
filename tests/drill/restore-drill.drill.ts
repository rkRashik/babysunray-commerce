import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import type { Client, Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assertToolsMatch, createBackupFile, EXCLUDED_TABLE_DATA, restoreBackupFile, verifyBackupFile } from "../../src/db/backup.mts";
import { parseSafeDatabaseUrl, TEST_TARGET } from "../../src/db/connection-guard.mts";
import type { Db } from "../../src/db/database";
import * as schema from "../../src/db/schema";
import type { Principal } from "../../src/modules/auth/principal";
import { reviewStates } from "../../src/modules/catalogue/review";
import { createProduct, createVariant } from "../../src/modules/catalogue/service";
import { createExport } from "../../src/modules/exports/service";
import { placeGuestOrder } from "../../src/modules/orders/guest-checkout";
import { checkCourierStatementOnce } from "../../src/modules/orders/statements";
import { savePolicyDraftOnce } from "../../src/modules/policies/drafts";
import { getStockCount } from "../../src/modules/inventory/counts";
import { applyStockCountOnce, recordCountsOnce, startStockCountOnce } from "../../src/modules/inventory/operations";
import { receiveStock } from "../../src/modules/inventory/service";
import {
  confirmOrderOnce,
  createReturnOnce,
  deliverOrderOnce,
  dispatchOrderOnce,
  inspectQuarantineOnce,
  markRtoOnce,
  packOrderOnce,
  receiveRtoOnce,
  recordPaymentOnce,
  returnStepOnce,
  setDeliveryZoneOnce,
  submitOrderOnce,
} from "../../src/modules/orders/operations";
import { getOrderDetail } from "../../src/modules/orders/queries";
import { dhakaToday } from "../../src/modules/orders/rules";
import { clearAuthState, createTestAuth, createVerifiedOwner } from "../support/auth";
import { createTestVariant, TEST_ACTOR } from "../support/fixtures";
import { publishNow } from "../support/publication";
import { dropManagedObjects } from "../support/global-setup";
import { unexpectedObjects } from "../support/schema-inventory";
import { connectTestClient, createTestDb } from "../support/test-database";

// Backup and restore drill (requirement K-6) on fictional data in babysunray_test: seed every kind of record,
// back up (encrypted), verify, empty the database with the guarded reset, restore, and compare everything.
// Elapsed times are observations, not an approved RTO (K-9 is open). The backup file is written to a new
// temporary directory outside the repository and deleted at the end.

let db: Db;
let pool: Pool;
let owner: Principal;
let workDir: string;
const key = () => randomUUID();
const today = dhakaToday();
const url = process.env.TEST_DATABASE_URL;

beforeAll(async () => {
  ({ db, pool } = await createTestDb(6));
  workDir = await mkdtemp(path.join(os.tmpdir(), "babysunray-drill-"));
});

afterAll(async () => {
  await pool?.end();
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

const tables = (Object.values(schema) as PgTable[]).map((t) => getTableConfig(t).name).sort();

/** Per table: row count and a digest of every row's text (order-independent); plus migrations and sequences. */
async function fingerprint(client: Client | Pool) {
  const out: Record<string, { rows: number; digest: string }> = {};
  for (const name of [...tables.map((t) => `public.${t}`), "drizzle.__drizzle_migrations"]) {
    const [schemaName, table] = name.split(".");
    const { rows } = await client.query<{ rows: string; digest: string }>(
      `select count(*) as rows, md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as digest from "${schemaName}"."${table}" t`,
    );
    out[name] = { rows: Number(rows[0].rows), digest: rows[0].digest };
  }
  const { rows: sequences } = await client.query<{ name: string; last: string | null }>(
    "select sequencename as name, last_value::text as last from pg_sequences where schemaname in ('public', 'drizzle') order by 1",
  );
  const { rows: constraints } = await client.query<{ kind: string; n: string; invalid: string }>(
    "select contype as kind, count(*) as n, count(*) filter (where not convalidated) as invalid from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public' group by 1 order by 1",
  );
  const { rows: triggers } = await client.query<{ name: string; enabled: string }>(
    "select tgname as name, tgenabled as enabled from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not tgisinternal order by 1",
  );
  return { tables: out, sequences, constraints, triggers };
}

async function seedFictionalBusiness() {
  const auth = createTestAuth(db);
  await clearAuthState(pool);
  ({ principal: owner } = await createVerifiedOwner(auth, db, pool, "drill-owner@example.test"));
  for (const [code, charge] of [["dhaka_city", 6_000], ["outside_dhaka", 12_000]] as const) {
    const { rows } = await pool.query<{ version: number }>("select version from delivery_zones where code = $1", [code]);
    await setDeliveryZoneOnce(db, owner, key(), { code, chargePaisa: charge, active: true, expectedVersion: rows[0]?.version ?? null });
  }
  const a = (await createTestVariant(db, "drill")).variant;
  const b = (await createTestVariant(db, "drill")).variant;
  await receiveStock(db, { sku: a.sku, quantity: 20, actor: TEST_ACTOR });
  await receiveStock(db, { sku: b.sku, quantity: 10, actor: TEST_ACTOR });
  const customer = { customerName: "Drill Customer", customerPhone: "01711000123", deliveryAddress: "House 9, Drill Road", deliveryZone: "dhaka_city" as const };
  const order = async (items: { sku: string; quantity: number }[]) => (await submitOrderOnce(db, owner, key(), { source: "messenger", ...customer, items })).value.id;
  const v = async (id: string) => (await getOrderDetail(db, id)).version;
  const step = async (op: (d: Db, p: Principal, k: string, i: { orderId: string; expectedVersion: number }) => Promise<unknown>, id: string) =>
    op(db, owner, key(), { orderId: id, expectedVersion: await v(id) });

  // Delivered with COD collected, partly settled, then a return inspected, restocked and refunded.
  const delivered = await order([{ sku: a.sku, quantity: 2 }, { sku: b.sku, quantity: 1 }]);
  for (const op of [confirmOrderOnce, packOrderOnce, dispatchOrderOnce, deliverOrderOnce]) await step(op, delivered);
  const total = (await getOrderDetail(db, delivered)).totalPaisa;
  await recordPaymentOnce(db, owner, key(), { orderId: delivered, expectedVersion: await v(delivered), kind: "collected", amountPaisa: total, occurredOn: today });
  await recordPaymentOnce(db, owner, key(), { orderId: delivered, expectedVersion: await v(delivered), kind: "settled", amountPaisa: 100_000, occurredOn: today });
  const itemId = (await getOrderDetail(db, delivered)).items.find((i) => i.sku === a.sku)!.id;
  await createReturnOnce(db, owner, key(), { orderId: delivered, expectedVersion: await v(delivered), kind: "return", reason: "wrong_or_defective", items: [{ orderItemId: itemId, quantity: 1 }] });
  const returnId = (await getOrderDetail(db, delivered)).returns[0].id;
  await returnStepOnce(db, owner, key(), { orderId: delivered, returnId, expectedVersion: await v(delivered), step: "receive", returnShippingCostPaisa: 8_000 });
  const quarantined = (await getOrderDetail(db, delivered)).quarantine[0].id;
  await inspectQuarantineOnce(db, owner, key(), { orderId: delivered, quarantineItemId: quarantined, expectedVersion: await v(delivered), outcome: "restock" });
  await returnStepOnce(db, owner, key(), { orderId: delivered, returnId, expectedVersion: await v(delivered), step: "approve" });
  await returnStepOnce(db, owner, key(), { orderId: delivered, returnId, expectedVersion: await v(delivered), step: "refund", amountPaisa: 85_000, method: "bkash", occurredOn: today });

  // RTO received into quarantine (awaiting inspection), and one order still pending verification.
  const rto = await order([{ sku: b.sku, quantity: 1 }]);
  for (const op of [confirmOrderOnce, packOrderOnce, dispatchOrderOnce, markRtoOnce, receiveRtoOnce]) await step(op, rto);
  await order([{ sku: a.sku, quantity: 3 }]);

  // An applied stock count and an audited export.
  const count = (await startStockCountOnce(db, owner, key(), { scope: "selected", skus: [a.sku] })).value;
  await recordCountsOnce(db, owner, key(), { countId: count.id, expectedVersion: count.version, entries: [{ variantId: a.id, counted: 18 }] });
  await applyStockCountOnce(db, owner, key(), { countId: count.id, expectedVersion: (await getStockCount(db, count.id)).version, reason: "Drill count" });
  for await (const chunk of (await createExport(db, owner, { dataset: "orders", format: "json", filters: {} })).chunks) void chunk;

  // Launch preparation (Gate H.25-H.26, H.32): a reviewed and published product, an order through the inactive guest service, a policy draft.
  const p = await createProduct(db, { slug: "drill-guest", nameEn: "Drill Guest Romper", nameBn: "ড্রিল রম্পার", descriptionEn: "Fictional.", descriptionBn: "কাল্পনিক।" });
  const g = await createVariant(db, { productId: p.id, sku: "DRILL-GUEST-1", size: "0-3M", colour: "Ivory", pricePaisa: 60_000 });
  await receiveStock(db, { sku: g.sku, quantity: 2, actor: TEST_ACTOR });
  await publishNow(db, owner, p.id); // reviewed, then published under the test-only rule
  await placeGuestOrder(db, key(), { customer: { name: "Drill Guest", phone: "01711000124", address: "House 10, Drill Road" }, deliveryZone: "dhaka_city", items: [{ sku: g.sku, quantity: 1, unitPricePaisa: 60_000 }], deliveryChargePaisa: 6_000, totalPaisa: 66_000 });
  await savePolicyDraftOnce(db, owner, key(), { kind: "delivery", expectedVersion: 0, bodyEn: "Fictional drill draft.", bodyBn: "কাল্পনিক খসড়া।" });
  // Gate H.39 and H.41: the sign-in audit (the Owner's sign-in above wrote rows) and a courier statement check.
  await checkCourierStatementOnce(db, owner, key(), { csv: "order_reference,collected_taka,deducted_taka,remitted_taka\r\nORD-999997,1,0,1\r\n" });
  return { bangla: "পরীক্ষামূলক রম্পার", reviewedProductId: p.id };
}

it("backs up, verifies, restores into an emptied babysunray_test and finds everything intact", async () => {
  const conn = parseSafeDatabaseUrl(url, TEST_TARGET);
  const started = Date.now();
  const { bangla, reviewedProductId } = await seedFictionalBusiness();
  const { rows: version } = await pool.query<{ v: string }>("show server_version_num");
  const pgDumpVersion = await assertToolsMatch(Math.floor(Number(version[0].v) / 10000));

  const client = await connectTestClient(url);
  let before: Awaited<ReturnType<typeof fingerprint>>;
  try {
    before = await fingerprint(client);
  } finally {
    await client.end();
  }
  expect(before.tables["public.orders"].rows).toBeGreaterThanOrEqual(3);
  expect(before.tables["public.auth_sessions"].rows).toBeGreaterThan(0); // excluded from the backup

  // 1. Back up (pg_dump straight into encryption), with an ephemeral passphrase that is never written anywhere.
  const passphrase = randomBytes(24).toString("base64url");
  const file = path.join(workDir, "babysunray_test-drill.bsbackup");
  const t1 = Date.now();
  const { bytes } = await createBackupFile(conn, passphrase, file, { pgDumpVersion });
  const backupMs = Date.now() - t1;
  expect((await stat(file)).size).toBe(bytes);

  // 2. Verify: authenticated decryption of the whole file into pg_restore --list.
  const t2 = Date.now();
  const verified = await verifyBackupFile(file, passphrase);
  const verifyMs = Date.now() - t2;
  expect(verified.header.database).toBe("babysunray_test");
  expect(verified.entries.some((e) => / TABLE DATA public orders /.test(e))).toBe(true);
  expect(verified.entries.some((e) => / TABLE DATA public auth_sessions /.test(e))).toBe(false);
  await expect(verifyBackupFile(file, "a wrong fictional passphrase")).rejects.toThrow();

  // 3. Empty the target with the guarded reset (identity, unexpected objects, RESTRICT drops) and prove it empty.
  await dropManagedObjects(url, async (c) => {
    const { rows } = await c.query<{ n: string }>(
      "select (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'drizzle')) + (select count(*) from pg_namespace where nspname = 'drizzle') as n",
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  // 4. Restore in one transaction.
  const t3 = Date.now();
  await restoreBackupFile(file, passphrase, conn);
  const restoreMs = Date.now() - t3;

  // 5. Compare.
  const after = await connectTestClient(url);
  try {
    const restored = await fingerprint(after);
    for (const [name, expected] of Object.entries(before.tables)) {
      if (EXCLUDED_TABLE_DATA.some((t) => name === `public.${t}`)) expect(restored.tables[name].rows, name).toBe(0);
      else expect(restored.tables[name], name).toEqual(expected);
    }
    expect(restored.sequences).toEqual(before.sequences);
    expect(restored.constraints).toEqual(before.constraints);
    expect(restored.constraints.every((c) => c.invalid === "0")).toBe(true);
    expect(restored.triggers).toEqual(before.triggers);
    expect(await unexpectedObjects(after)).toEqual([]);

    const q = async (sql: string) => (await after.query(sql)).rows[0];
    expect((await q("select count(*)::int as n from (select number from orders group by number having count(*) > 1) d")).n).toBe(0);
    expect(
      (await q(`select count(*)::int as n from inventory_balances b where b.reserved > b.on_hand
                 or b.on_hand <> coalesce((select sum(quantity_delta) from stock_movements m where m.variant_id = b.variant_id), 0)
                 or b.reserved <> coalesce((select sum(quantity) from stock_reservations r where r.variant_id = b.variant_id and r.status = 'active'), 0)`)).n,
    ).toBe(0);
    expect((await q("select count(*)::int as n from orders o where o.subtotal_paisa <> (select sum(line_total_paisa) from order_items i where i.order_id = o.id)")).n).toBe(0);
    expect((await q(`select count(*)::int as n from products where name_bn = '${bangla}'`)).n).toBeGreaterThan(0);
    expect((await q("select count(*)::int as n from orders where customer_phone = '01711000123'")).n).toBeGreaterThanOrEqual(3);
    // Append-only rules survive the restore, and new rows continue the sequences.
    await expect(after.query("delete from order_events")).rejects.toThrow(/append-only/);
    await expect(after.query("delete from guest_checkout_submissions")).rejects.toThrow(/not allowed/);
    // Publication state and its history survive, and the history stays append-only.
    expect((await q(`select status from products where id = '${reviewedProductId}'`)).status).toBe("published");
    expect((await q(`select count(*)::int as n from product_publication_events where product_id = '${reviewedProductId}' and event = 'published'`)).n).toBe(1);
    await expect(after.query("delete from product_publication_events")).rejects.toThrow(/append-only/);
    // The authentication audit and the courier statement checks survive, append-only, and the access trigger still fires.
    expect((await q("select count(*)::int as n from auth_events where event = 'sign_in'")).n).toBeGreaterThan(0);
    expect((await q("select count(*)::int as n from auth_events where event = 'access_changed'")).n).toBeGreaterThan(0);
    expect((await q("select count(*)::int as n from courier_statement_checks where not_found = 1")).n).toBe(1);
    for (const table of ["auth_events", "courier_statement_checks"]) await expect(after.query(`delete from ${table}`)).rejects.toThrow(/append-only/);
    expect((await q("select count(*)::int as n from pg_trigger where tgname = 'user_access_audit' and not tgisinternal")).n).toBe(1);
    // A review stays current after the restore: the content digest does not depend on the database it is computed in.
    const { db: restoredDb, pool: restoredPool } = await createTestDb(1);
    try {
      expect((await reviewStates(restoredDb, [reviewedProductId])).get(reviewedProductId)?.current).toBe(true);
    } finally {
      await restoredPool.end();
    }
    const maxBefore = Number((await q("select max(number) as n from orders")).n);
    await after.query("begin");
    const next = await after.query<{ n: string }>("select nextval('orders_number_seq') as n");
    await after.query("rollback");
    expect(Number(next.rows[0].n)).toBeGreaterThan(maxBefore);
  } finally {
    await after.end();
  }

  // 6. A short, sanitised report (no customer data, no paths, no passphrase).
  const totalRows = Object.values(before.tables).reduce((n, t) => n + t.rows, 0);
  console.log(
    JSON.stringify(
      {
        drill: "backup-restore",
        result: "passed",
        database: "babysunray_test (fictional data)",
        pgDump: pgDumpVersion,
        tablesCompared: Object.keys(before.tables).length,
        rowsBackedUp: totalRows,
        tableDataExcluded: EXCLUDED_TABLE_DATA,
        archiveEntries: verified.entries.length,
        backupBytes: bytes,
        timingsMs: { backup: backupMs, verify: verifyMs, restore: restoreMs, total: Date.now() - started },
        note: "Times are observations on this machine, not an approved RTO.",
      },
      null,
      2,
    ),
  );
});
