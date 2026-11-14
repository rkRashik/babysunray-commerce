import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/database";
import type { Actor } from "../../src/modules/actor";
import { deactivateVariant } from "../../src/modules/catalogue/service";
import { MAX_STOCK_QUANTITY } from "../../src/modules/inventory/rules";
import {
  adjustStock,
  getStockLevel,
  listStockMovements,
  receiveStock,
} from "../../src/modules/inventory/service";
import { createTestVariant, errorCodeOf, TEST_ACTOR, withFailingInserts } from "../support/fixtures";
import { createTestDb } from "../support/test-database";

let db: Db;
let pool: Pool;

beforeAll(async () => {
  ({ db, pool } = await createTestDb());
});

afterAll(async () => {
  await pool?.end();
});

async function newSku(): Promise<{ sku: string; variantId: string }> {
  const { variant } = await createTestVariant(db, "inv");
  return { sku: variant.sku, variantId: variant.id };
}

async function movementCount(variantId: string): Promise<number> {
  const { rows } = await pool.query("select count(*)::int as n from stock_movements where variant_id = $1", [variantId]);
  return rows[0].n;
}

describe("stock receipts", () => {
  it("adds stock and records the receipt with its actor", async () => {
    const { sku } = await newSku();
    const result = await receiveStock(db, { sku: ` ${sku.toLowerCase()} `, quantity: 12, actor: TEST_ACTOR });
    expect(result.onHand).toBe(12);
    expect(result.movement).toMatchObject({
      movementType: "receipt",
      quantityDelta: 12,
      reason: null,
      actorType: "system",
      actorRef: "integration-test",
    });
    expect(result.movement.createdAt).toBeInstanceOf(Date);
    expect((await getStockLevel(db, sku)).onHand).toBe(12);
  });

  it("rejects non-positive or fractional quantities without changing anything", async () => {
    const { sku, variantId } = await newSku();
    for (const quantity of [0, -3, 1.5]) {
      expect(await errorCodeOf(receiveStock(db, { sku, quantity, actor: TEST_ACTOR }))).toBe("INVALID_INPUT");
    }
    expect((await getStockLevel(db, sku)).onHand).toBe(0);
    expect(await movementCount(variantId)).toBe(0);
  });

  it("accepts physical stock for an inactive SKU without reactivating it", async () => {
    const { sku, variantId } = await newSku();
    await deactivateVariant(db, variantId);
    const received = await receiveStock(db, { sku, quantity: 4, actor: TEST_ACTOR });
    expect(received.onHand).toBe(4);
    const adjusted = await adjustStock(db, { sku, quantityDelta: -1, reason: "Counted", actor: TEST_ACTOR });
    expect(adjusted.onHand).toBe(3);
    const { rows } = await pool.query("select status from variants where id = $1", [variantId]);
    expect(rows[0].status).toBe("inactive");
  });

  it("rejects an unknown SKU", async () => {
    expect(await errorCodeOf(receiveStock(db, { sku: "INV-NOPE", quantity: 1, actor: TEST_ACTOR }))).toBe(
      "VARIANT_NOT_FOUND",
    );
  });

  it("refuses a receipt that would overflow the stock quantity, leaving no partial change", async () => {
    const { sku, variantId } = await newSku();
    await receiveStock(db, { sku, quantity: MAX_STOCK_QUANTITY, actor: TEST_ACTOR });
    expect(await errorCodeOf(receiveStock(db, { sku, quantity: 1, actor: TEST_ACTOR }))).toBe("STOCK_LIMIT_EXCEEDED");
    expect((await getStockLevel(db, sku)).onHand).toBe(MAX_STOCK_QUANTITY);
    expect(await movementCount(variantId)).toBe(1);
  });
});

describe("stock adjustments", () => {
  it("applies positive and negative adjustments with their reasons", async () => {
    const { sku } = await newSku();
    await receiveStock(db, { sku, quantity: 10, actor: TEST_ACTOR });
    expect((await adjustStock(db, { sku, quantityDelta: -3, reason: "Damaged in storage", actor: TEST_ACTOR })).onHand).toBe(7);
    expect((await adjustStock(db, { sku, quantityDelta: 2, reason: " Found in recount ", actor: TEST_ACTOR })).onHand).toBe(9);
    const history = await listStockMovements(db, sku);
    expect(history.map((m) => [m.movementType, m.quantityDelta, m.reason])).toEqual([
      ["receipt", 10, null],
      ["adjustment", -3, "Damaged in storage"],
      ["adjustment", 2, "Found in recount"],
    ]);
  });

  it("requires a reason, in the service and in the database", async () => {
    const { sku, variantId } = await newSku();
    for (const reason of ["", "   ", undefined as unknown as string]) {
      expect(await errorCodeOf(adjustStock(db, { sku, quantityDelta: 1, reason, actor: TEST_ACTOR }))).toBe("INVALID_INPUT");
    }
    expect(await movementCount(variantId)).toBe(0);
    expect(
      await errorCodeOf(
        pool.query(
          `insert into stock_movements (variant_id, movement_type, quantity_delta, actor_type, actor_ref)
           values ($1, 'adjustment', 1, 'system', 'integration-test')`,
          [variantId],
        ),
      ),
    ).toBe("23514");
  });

  it("never takes stock below zero and leaves no partial change when refused", async () => {
    const { sku, variantId } = await newSku();
    await receiveStock(db, { sku, quantity: 3, actor: TEST_ACTOR });
    expect(await errorCodeOf(adjustStock(db, { sku, quantityDelta: -4, reason: "Recount", actor: TEST_ACTOR }))).toBe(
      "INSUFFICIENT_STOCK",
    );
    expect((await getStockLevel(db, sku)).onHand).toBe(3);
    expect(await movementCount(variantId)).toBe(1);
    expect((await adjustStock(db, { sku, quantityDelta: -3, reason: "Recount", actor: TEST_ACTOR })).onHand).toBe(0);
  });

  it("rejects a negative balance at the database level", async () => {
    const { variantId } = await newSku();
    expect(
      await errorCodeOf(pool.query("update inventory_balances set on_hand = -1 where variant_id = $1", [variantId])),
    ).toBe("23514");
  });
});

describe("actors", () => {
  it("rejects forged user actors and free-text references in the service and in the database", async () => {
    const { sku, variantId } = await newSku();
    const fakeUser = { type: "user", ref: "owner" } as unknown as Actor;
    expect(await errorCodeOf(receiveStock(db, { sku, quantity: 1, actor: fakeUser }))).toBe("INVALID_INPUT");
    expect(await errorCodeOf(receiveStock(db, { sku, quantity: 1, actor: { type: "system", ref: "Some Person" } }))).toBe(
      "INVALID_INPUT",
    );
    for (const [type, ref] of [
      ["user", "owner"],
      ["system", "Some Person"],
    ]) {
      expect(
        await errorCodeOf(
          pool.query(
            `insert into stock_movements (variant_id, movement_type, quantity_delta, actor_type, actor_ref)
             values ($1, 'receipt', 1, $2, $3)`,
            [variantId, type, ref],
          ),
        ),
      ).toBe("23514");
    }
  });
});

describe("transaction integrity", () => {
  it("rolls back the balance change when the ledger insert fails", async () => {
    const { sku, variantId } = await newSku();
    await receiveStock(db, { sku, quantity: 5, actor: TEST_ACTOR });
    // The balance UPDATE succeeds inside the transaction, then the movement INSERT fails.
    await expect(
      withFailingInserts(pool, "stock_movements", () =>
        adjustStock(db, { sku, quantityDelta: -2, reason: "Recount", actor: TEST_ACTOR }),
      ),
    ).rejects.toMatchObject({ cause: { message: "injected test failure" } });
    expect((await getStockLevel(db, sku)).onHand).toBe(5);
    expect(await movementCount(variantId)).toBe(1);
  });

  it("rejects UPDATE, DELETE and TRUNCATE on the ledger", async () => {
    const { sku, variantId } = await newSku();
    await receiveStock(db, { sku, quantity: 1, actor: TEST_ACTOR });
    const attempts = [
      ["update stock_movements set quantity_delta = 100 where variant_id = $1", [variantId]],
      ["delete from stock_movements where variant_id = $1", [variantId]],
      ["update stock_movements set reason = 'x' where false", []],
      ["truncate stock_movements", []],
    ] as const;
    for (const [statement, params] of attempts) {
      expect(await errorCodeOf(pool.query(statement, [...params]))).toBe("23001");
    }
    expect((await listStockMovements(db, sku)).map((m) => m.quantityDelta)).toEqual([1]);
  });
});

describe("concurrency", () => {
  // Explicit coordination: a separate connection holds the balance row lock while every attempt starts.
  // The test waits until PostgreSQL reports all attempts blocked on that lock, then releases it, so the
  // attempts are proven to overlap instead of running one after another by chance.
  async function raceToDecrement(sku: string, variantId: string, attempts: number) {
    // One connection per attempt, so every attempt is a genuinely independent PostgreSQL session.
    const { db: racingDb, pool: racingPool } = await createTestDb(attempts);
    const gate = await pool.connect();
    try {
      await gate.query("begin");
      await gate.query("select on_hand from inventory_balances where variant_id = $1 for update", [variantId]);
      const outcomes = Array.from({ length: attempts }, (_, i) =>
        adjustStock(racingDb, { sku, quantityDelta: -1, reason: `Concurrent test ${i}`, actor: TEST_ACTOR }).then(
          (change) => ({ ok: true as const, onHand: change.onHand }),
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

  async function waitForLockWaiters(expected: number) {
    const deadline = Date.now() + 3_000;
    for (;;) {
      const { rows } = await pool.query(
        `select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and query like '%inventory_balances%'`,
      );
      if (rows[0].n === expected) return;
      if (Date.now() > deadline) throw new Error(`Only ${rows[0].n} of ${expected} attempts reached the row lock.`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it("lets exactly one of two concurrent requests take the last unit", async () => {
    const { sku, variantId } = await newSku();
    await receiveStock(db, { sku, quantity: 1, actor: TEST_ACTOR });

    const outcomes = await raceToDecrement(sku, variantId, 2);

    expect(outcomes.filter((o) => o.ok)).toEqual([{ ok: true, onHand: 0 }]);
    expect(outcomes.filter((o) => !o.ok)).toEqual([{ ok: false, code: "INSUFFICIENT_STOCK" }]);
    expect((await getStockLevel(db, sku)).onHand).toBe(0);
    expect((await listStockMovements(db, sku)).map((m) => m.quantityDelta)).toEqual([1, -1]);
  });

  it("never oversells when more requests than units arrive at once", async () => {
    const { sku, variantId } = await newSku();
    await receiveStock(db, { sku, quantity: 3, actor: TEST_ACTOR });

    const outcomes = await raceToDecrement(sku, variantId, 3 + 3);

    expect(outcomes.filter((o) => o.ok)).toHaveLength(3);
    expect(outcomes.filter((o) => !o.ok).every((o) => o.code === "INSUFFICIENT_STOCK")).toBe(true);
    expect((await getStockLevel(db, sku)).onHand).toBe(0);
    expect(await movementCount(variantId)).toBe(1 + 3);
  });
});

describe("reconciliation", () => {
  it("every balance equals the sum of its ledger movements", async () => {
    // Covers every variant in the test database at this point of the run, not only this file's.
    const { rows } = await pool.query(
      `select b.variant_id, b.on_hand, coalesce(sum(m.quantity_delta), 0)::int as ledger
         from inventory_balances b left join stock_movements m on m.variant_id = b.variant_id
        group by b.variant_id, b.on_hand
       having b.on_hand <> coalesce(sum(m.quantity_delta), 0)`,
    );
    expect(rows).toEqual([]);
    const { rows: total } = await pool.query("select count(*)::int as n from stock_movements");
    expect(total[0].n).toBeGreaterThan(10);
  });
});
