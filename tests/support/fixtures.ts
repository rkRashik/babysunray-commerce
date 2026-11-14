import type { Pool } from "pg";
import type { Db } from "../../src/db/database";
import type { Actor } from "../../src/modules/actor";
import { createProduct, createVariant } from "../../src/modules/catalogue/service";

// Fictional data only. Each test file passes its own prefix, so files never share fixture rows.
export const TEST_ACTOR: Actor = { type: "system", ref: "integration-test" };

let counter = 0;

export async function createTestVariant(db: Db, prefix: string) {
  counter += 1;
  const product = await createProduct(db, {
    slug: `${prefix}-romper-${counter}`,
    nameEn: "Test Romper",
    nameBn: "পরীক্ষামূলক রম্পার",
  });
  const variant = await createVariant(db, {
    productId: product.id,
    sku: `${prefix}-ROMPER-${counter}`,
    size: "0-3M",
    colour: "Ivory",
    pricePaisa: 85_000,
  });
  return { product, variant };
}

/**
 * Makes every INSERT into `table` fail while `run` executes, to simulate a failure in the middle of a
 * transaction. The trigger and function are removed afterwards; if a crash leaves them behind, the next
 * `npm run test:db` stops at the unexpected-object check instead of dropping them.
 */
export async function withFailingInserts<T>(pool: Pool, table: string, run: () => Promise<T>): Promise<T> {
  await pool.query(
    `create function test_injected_failure() returns trigger language plpgsql as
     $$ begin raise exception 'injected test failure'; end $$`,
  );
  try {
    await pool.query(
      `create trigger test_injected_failure before insert on "${table}"
       for each row execute function test_injected_failure()`,
    );
    return await run();
  } finally {
    await pool.query("drop function test_injected_failure() cascade");
  }
}

export async function errorCodeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
  }
  throw new Error("Expected the operation to fail.");
}
