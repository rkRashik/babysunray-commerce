import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/database";
import type { Principal } from "../../src/modules/auth/principal";
import {
  archiveProductOnce,
  createProductOnce,
  createVariantOnce,
  deactivateVariantOnce,
} from "../../src/modules/catalogue/operations";
import { getStockLevel, listStockMovements, receiveStock } from "../../src/modules/inventory/service";
import { adjustStockOnce, receiveStockOnce } from "../../src/modules/inventory/operations";
import { runOnce } from "../../src/modules/idempotency/service";
import { clearAuthState, count, createTestAuth, createVerifiedOwner } from "../support/auth";
import { createTestVariant, errorCodeOf, TEST_ACTOR, withFailingInserts } from "../support/fixtures";
import { createTestDb } from "../support/test-database";

// Operation-level idempotency and the shared application operations, against real PostgreSQL with
// independent connections. Concurrency tests hold a row lock from a separate session and wait until
// PostgreSQL reports every attempt blocked before releasing it, so overlap is proven, not left to timing.

let db: Db;
let pool: Pool;
let ownerA: Principal;
let ownerB: Principal;
let ownerAId: string;

beforeAll(async () => {
  ({ db, pool } = await createTestDb(4));
  const auth = createTestAuth(db);
  await clearAuthState(pool);
  ({ principal: ownerA, userId: ownerAId } = await createVerifiedOwner(auth, db, pool, "ops-owner-a@example.test"));
  ({ principal: ownerB } = await createVerifiedOwner(auth, db, pool, "ops-owner-b@example.test"));
});

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  await pool.query("delete from auth_rate_limits");
});

const key = () => randomUUID();

async function newSku(stock = 0) {
  const { variant, product } = await createTestVariant(db, "ops");
  if (stock > 0) await receiveStock(db, { sku: variant.sku, quantity: stock, actor: TEST_ACTOR });
  return { sku: variant.sku, variantId: variant.id, productId: product.id };
}

const movements = (variantId: string) => count(pool, "select count(*) from stock_movements where variant_id = $1", [variantId]);
const records = (k: string) => count(pool, "select count(*) from idempotency_records where idempotency_key = $1", [k]);

describe("sequential retries", () => {
  it("a retried receipt with the same key is one operation and returns the committed result", async () => {
    const { sku, variantId } = await newSku();
    const k = key();
    const first = await receiveStockOnce(db, ownerA, k, { sku, quantity: 5 });
    const second = await receiveStockOnce(db, ownerA, k, { sku: sku.toLowerCase(), quantity: 5 });
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.value).toEqual(first.value);
    expect(first.value).toMatchObject({ sku, variantId, onHand: 5, movement: { quantityDelta: 5, actorType: "user", actorRef: ownerAId } });
    expect(await movements(variantId)).toBe(1);
    expect((await getStockLevel(db, sku)).onHand).toBe(5);
    expect(await records(k)).toBe(1);
  });

  it("a lost response is recovered: the retry returns the original result even after later changes", async () => {
    const { sku, variantId } = await newSku(10);
    const k = key();
    const lost = await adjustStockOnce(db, ownerA, k, { sku, quantityDelta: -3, reason: "Recount" });
    await adjustStockOnce(db, ownerA, key(), { sku, quantityDelta: -2, reason: "Recount" });
    const retry = await adjustStockOnce(db, ownerA, k, { sku, quantityDelta: -3, reason: "Recount" });
    expect(retry).toEqual({ value: lost.value, replayed: true });
    expect(retry.value.onHand).toBe(7);
    expect((await getStockLevel(db, sku)).onHand).toBe(5);
    expect(await movements(variantId)).toBe(3);
  });

  it("refuses the same key with a changed request or another operation, and runs nothing", async () => {
    const { sku, variantId } = await newSku(10);
    const k = key();
    await adjustStockOnce(db, ownerA, k, { sku, quantityDelta: -1, reason: "Recount" });
    for (const attempt of [
      () => adjustStockOnce(db, ownerA, k, { sku, quantityDelta: -2, reason: "Recount" }),
      () => adjustStockOnce(db, ownerA, k, { sku, quantityDelta: -1, reason: "Different reason" }),
      () => receiveStockOnce(db, ownerA, k, { sku, quantity: 1 }),
    ]) {
      expect(await errorCodeOf(attempt())).toBe("IDEMPOTENCY_KEY_REUSED");
    }
    expect((await getStockLevel(db, sku)).onHand).toBe(9);
    expect(await movements(variantId)).toBe(2);
  });

  it("different keys are independent operations", async () => {
    const { sku, variantId } = await newSku();
    await receiveStockOnce(db, ownerA, key(), { sku, quantity: 2 });
    await receiveStockOnce(db, ownerA, key(), { sku, quantity: 2 });
    expect((await getStockLevel(db, sku)).onHand).toBe(4);
    expect(await movements(variantId)).toBe(2);
  });

  it("rejects malformed keys before anything runs", async () => {
    const { sku, variantId } = await newSku();
    for (const bad of ["", "short", "x".repeat(129), "has space in the key 123", "ünïcode-key-1234567"]) {
      expect(await errorCodeOf(receiveStockOnce(db, ownerA, bad, { sku, quantity: 1 }))).toBe("INVALID_INPUT");
    }
    expect(await movements(variantId)).toBe(0);
  });
});

describe("isolation between users and authorisation", () => {
  it("scopes keys to the verified user: another user's same key is a separate operation, never a replay", async () => {
    const { sku, variantId } = await newSku();
    const k = key();
    const a = await receiveStockOnce(db, ownerA, k, { sku, quantity: 1 });
    const b = await receiveStockOnce(db, ownerB, k, { sku, quantity: 1 });
    expect(b.replayed).toBe(false);
    expect(b.value.movement.id).not.toBe(a.value.movement.id);
    expect(b.value.movement.actorRef).toBe(ownerB.userId);
    expect((await receiveStockOnce(db, ownerA, k, { sku, quantity: 1 })).value.movement.id).toBe(a.value.movement.id);
    expect(await movements(variantId)).toBe(2);
    expect(await records(k)).toBe(2);
  });

  it("checks the principal before looking at the key: a forged principal cannot replay or run", async () => {
    const { sku, variantId } = await newSku();
    const k = key();
    await receiveStockOnce(db, ownerA, k, { sku, quantity: 1 });
    const forged = { userId: ownerAId, role: "owner" } as Principal;
    expect(await errorCodeOf(receiveStockOnce(db, forged, k, { sku, quantity: 1 }))).toBe("UNAUTHENTICATED");
    expect(await errorCodeOf(createProductOnce(db, forged, key(), { slug: "ops-forged", nameEn: "X" }))).toBe("UNAUTHENTICATED");
    expect(await movements(variantId)).toBe(1);
  });
});

describe("atomicity", () => {
  it("a failure after the balance update rolls back balance, ledger and the key claim; a retry then runs once", async () => {
    const { sku, variantId } = await newSku(5);
    const k = key();
    await expect(
      withFailingInserts(pool, "stock_movements", () => adjustStockOnce(db, ownerA, k, { sku, quantityDelta: -2, reason: "Recount" })),
    ).rejects.toMatchObject({ cause: { message: "injected test failure" } });
    expect((await getStockLevel(db, sku)).onHand).toBe(5);
    expect(await movements(variantId)).toBe(1);
    expect(await records(k)).toBe(0);

    const retry = await adjustStockOnce(db, ownerA, k, { sku, quantityDelta: -2, reason: "Recount" });
    expect(retry.replayed).toBe(false);
    expect(retry.value.onHand).toBe(3);
  });

  it("a failure while storing the result (after balance and ledger) rolls everything back", async () => {
    const { sku, variantId } = await newSku(5);
    const k = key();
    await expect(
      withFailingInserts(pool, "idempotency_records", () => receiveStockOnce(db, ownerA, k, { sku, quantity: 1 }), "update"),
    ).rejects.toMatchObject({ cause: { message: "injected test failure" } });
    expect((await getStockLevel(db, sku)).onHand).toBe(5);
    expect(await movements(variantId)).toBe(1);
    expect(await records(k)).toBe(0);
  });

  it("a refused operation (not enough stock) leaves no record, so the key stays usable", async () => {
    const { sku } = await newSku(1);
    const k = key();
    expect(await errorCodeOf(adjustStockOnce(db, ownerA, k, { sku, quantityDelta: -2, reason: "Recount" }))).toBe("INSUFFICIENT_STOCK");
    expect(await records(k)).toBe(0);
    await receiveStock(db, { sku, quantity: 5, actor: TEST_ACTOR });
    expect((await adjustStockOnce(db, ownerA, k, { sku, quantityDelta: -2, reason: "Recount" })).value.onHand).toBe(4);
  });

  it("composes several operations in one outer transaction: all commit or none do", async () => {
    const one = await newSku();
    const two = await newSku();
    const k1 = key();
    const k2 = key();
    await expect(
      db.transaction(async (tx) => {
        await receiveStockOnce(tx, ownerA, k1, { sku: one.sku, quantity: 3 });
        await adjustStockOnce(tx, ownerA, k2, { sku: two.sku, quantityDelta: -1, reason: "Recount" });
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect((await getStockLevel(db, one.sku)).onHand).toBe(0);
    expect(await records(k1)).toBe(0);
    expect(await records(k2)).toBe(0);
  });
});

describe("concurrency", () => {
  async function waitForLockWaiters(expected: number) {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const n = await count(
        pool,
        `select count(*) from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and (query like '%inventory_balances%' or query like '%idempotency_records%')`,
      );
      if (n === expected) return;
      if (Date.now() > deadline) throw new Error(`Only ${n} of ${expected} attempts were blocked.`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** Starts every attempt on its own connection while the balance row is locked, then releases the lock. */
  async function race<T>(variantId: string, attempts: number, run: (racingDb: Db, i: number) => Promise<T>) {
    const { db: racingDb, pool: racingPool } = await createTestDb(attempts);
    const gate = await pool.connect();
    try {
      await gate.query("begin");
      await gate.query("select on_hand from inventory_balances where variant_id = $1 for update", [variantId]);
      const outcomes = Array.from({ length: attempts }, (_, i) =>
        run(racingDb, i).then(
          (value) => ({ ok: true as const, value }),
          (error: { code?: string }) => ({ ok: false as const, code: error.code }),
        ),
      );
      try {
        await waitForLockWaiters(attempts);
      } finally {
        await gate.query("commit");
      }
      return await Promise.all(outcomes);
    } finally {
      gate.release();
      await racingPool.end();
    }
  }

  it("concurrent requests with the same key adjust stock exactly once; the others replay the committed result", async () => {
    const { sku, variantId } = await newSku(5);
    const k = key();
    const outcomes = await race(variantId, 5, (racingDb) => adjustStockOnce(racingDb, ownerA, k, { sku, quantityDelta: -1, reason: "Recount" }));
    const values = outcomes.map((o) => (o.ok ? o.value : null));
    expect(values.every((v) => v !== null)).toBe(true);
    expect(values.filter((v) => !v!.replayed)).toHaveLength(1);
    expect(new Set(values.map((v) => v!.value.movement.id)).size).toBe(1);
    expect(values.every((v) => v!.value.onHand === 4)).toBe(true);
    expect((await getStockLevel(db, sku)).onHand).toBe(4);
    expect(await movements(variantId)).toBe(2);
    expect(await records(k)).toBe(1);
  });

  it("concurrent last-unit decrements with different keys: exactly one succeeds and only it is recorded", async () => {
    const { sku, variantId } = await newSku(1);
    const keys = [key(), key()];
    const outcomes = await race(variantId, 2, (racingDb, i) =>
      adjustStockOnce(racingDb, ownerA, keys[i], { sku, quantityDelta: -1, reason: "Recount" }),
    );
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok)).toEqual([{ ok: false, code: "INSUFFICIENT_STOCK" }]);
    expect((await getStockLevel(db, sku)).onHand).toBe(0);
    expect((await listStockMovements(db, sku)).map((m) => m.quantityDelta)).toEqual([1, -1]);
    expect((await records(keys[0])) + (await records(keys[1]))).toBe(1);
  });
});

describe("catalogue operations", () => {
  it("creates a draft product once per key, in both languages", async () => {
    const k = key();
    const input = { slug: "ops-draft-1", nameEn: "Cotton Romper", nameBn: "সুতির রম্পার", descriptionBn: "নরম কাপড়" };
    const first = await createProductOnce(db, ownerA, k, input);
    const again = await createProductOnce(db, ownerA, k, input);
    expect(first.value).toMatchObject({ slug: "ops-draft-1", status: "draft", nameBn: "সুতির রম্পার", descriptionEn: null, variants: [] });
    expect(again).toEqual({ value: first.value, replayed: true });
    expect(await count(pool, "select count(*) from products where slug = 'ops-draft-1'")).toBe(1);
    expect(await errorCodeOf(createProductOnce(db, ownerA, key(), input))).toBe("SLUG_TAKEN");
  });

  it("creates a variant with a zero balance; a duplicate SKU (any case) is a conflict and leaves no record", async () => {
    const { value: product } = await createProductOnce(db, ownerA, key(), { slug: "ops-draft-2", nameEn: "Bib" });
    const k = key();
    const { value: variant } = await createVariantOnce(db, ownerA, k, { productId: product.id, sku: "ops-bib-01", pricePaisa: 25_050 });
    expect(variant).toMatchObject({ sku: "OPS-BIB-01", pricePaisa: 25_050, status: "active" });
    expect((await getStockLevel(db, "OPS-BIB-01")).onHand).toBe(0);
    const k2 = key();
    expect(await errorCodeOf(createVariantOnce(db, ownerA, k2, { productId: product.id, sku: " OPS-bib-01 ", pricePaisa: 100 }))).toBe("SKU_TAKEN");
    expect(await records(k2)).toBe(0);
    expect(await errorCodeOf(createVariantOnce(db, ownerA, key(), { productId: randomUUID(), sku: "OPS-BIB-02", pricePaisa: 100 }))).toBe(
      "PRODUCT_NOT_FOUND",
    );
    for (const pricePaisa of [0, -1, 1.5]) {
      expect(await errorCodeOf(createVariantOnce(db, ownerA, key(), { productId: product.id, sku: "OPS-BIB-03", pricePaisa }))).toBe("INVALID_INPUT");
    }
  });

  it("archives a product and deactivates a variant without deleting anything; replays return current state", async () => {
    const { product, variant } = await createTestVariant(db, "opsarc");
    const k = key();
    const archived = await archiveProductOnce(db, ownerA, k, product.id);
    expect(archived.value.status).toBe("archived");
    expect((await archiveProductOnce(db, ownerA, k, product.id)).replayed).toBe(true);
    const deactivated = await deactivateVariantOnce(db, ownerA, key(), variant.id);
    expect(deactivated.value.status).toBe("inactive");
    expect(await count(pool, "select count(*) from variants where id = $1", [variant.id])).toBe(1);
    expect(await errorCodeOf(archiveProductOnce(db, ownerA, key(), randomUUID()))).toBe("PRODUCT_NOT_FOUND");
    expect(await errorCodeOf(deactivateVariantOnce(db, ownerA, key(), randomUUID()))).toBe("VARIANT_NOT_FOUND");
    // Same key, different target: refused.
    expect(await errorCodeOf(archiveProductOnce(db, ownerA, k, (await newSku()).productId))).toBe("IDEMPOTENCY_KEY_REUSED");
  });
});

describe("invariants", () => {
  it("runOnce never commits a record without a result, and every stock record names its user's ledger row", async () => {
    await expect(
      runOnce(db, { userId: ownerAId, operation: "test.fail", key: key(), request: {} }, async () => {
        throw new Error("business failure");
      }, async () => null),
    ).rejects.toThrow("business failure");
    expect(await count(pool, "select count(*) from idempotency_records where result is null")).toBe(0);
    expect(
      await count(
        pool,
        `select count(*) from idempotency_records r
           left join stock_movements m on m.id = (r.result->>'movementId')::bigint and m.actor_user_id = r.user_id
          where r.operation in ('stock.receive', 'stock.adjust') and m.id is null`,
      ),
    ).toBe(0);
    const { rows } = await pool.query(
      `select b.variant_id from inventory_balances b left join stock_movements m on m.variant_id = b.variant_id
        group by b.variant_id, b.on_hand having b.on_hand <> coalesce(sum(m.quantity_delta), 0)`,
    );
    expect(rows).toEqual([]);
  });

  it("stores no request content: only ids, a fingerprint and the result reference", async () => {
    const { sku } = await newSku();
    const k = key();
    await receiveStockOnce(db, ownerA, k, { sku, quantity: 1, reason: "Supplier delivery note QXZ-PLM" }); // letters no hex fingerprint, id or date can contain
    const { rows } = await pool.query("select * from idempotency_records where idempotency_key = $1", [k]);
    expect(Object.keys(rows[0]).sort()).toEqual(["created_at", "idempotency_key", "operation", "request_fingerprint", "result", "user_id"]);
    expect(JSON.stringify(rows[0])).not.toContain("QXZ-PLM");
    expect(Object.keys(rows[0].result).sort()).toEqual(["movementId", "onHand"]);
  });
});
