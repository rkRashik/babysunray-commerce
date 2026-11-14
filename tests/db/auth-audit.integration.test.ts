import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/database";
import type { Actor } from "../../src/modules/actor";
import { actorFor, getPrincipal, type Principal } from "../../src/modules/auth/principal";
import { adjustStock, listStockMovements, receiveStock } from "../../src/modules/inventory/service";
import { createTestAuth, createTestUser, headersWith, signIn } from "../support/auth";
import { createTestVariant, errorCodeOf, TEST_ACTOR } from "../support/fixtures";
import { createTestDb } from "../support/test-database";

// Ledger rows record the authenticated user's immutable id, taken only from a verified session. Legacy
// system actors keep working, forged user actors are refused, and the database enforces the same rules.

const AUDITOR = { email: "auditor@example.test", password: "auditor long password", role: "owner" as const };

let db: Db;
let pool: Pool;
let auth: ReturnType<typeof createTestAuth>;
let auditorId: string;
let principal: Principal;

beforeAll(async () => {
  ({ db, pool } = await createTestDb());
  auth = createTestAuth(db);
  await pool.query("delete from auth_rate_limits");
  auditorId = await createTestUser(pool, { ...AUDITOR, name: "Test Auditor" });
  const { cookie } = await signIn(auth, AUDITOR.email, AUDITOR.password);
  principal = (await getPrincipal(auth, db, headersWith(cookie)))!;
});

afterAll(async () => {
  await pool?.end();
});

let sku: string;
let variantId: string;
beforeEach(async () => {
  const { variant } = await createTestVariant(db, "aud");
  ({ sku, id: variantId } = variant);
});

const insertMovement = (type: string, ref: string, userId: string | null) =>
  pool.query(
    `insert into stock_movements (variant_id, movement_type, quantity_delta, actor_type, actor_ref, actor_user_id)
     values ($1, 'receipt', 1, $2, $3, $4)`,
    [variantId, type, ref, userId],
  );

describe("authenticated actors", () => {
  it("records the verified user's id, not a name or email", async () => {
    expect(principal.userId).toBe(auditorId);
    const { movement } = await receiveStock(db, { sku, quantity: 5, actor: actorFor(principal) });
    expect(movement).toMatchObject({ actorType: "user", actorRef: auditorId, actorUserId: auditorId });
    const { rows } = await pool.query("select actor_type, actor_ref, actor_user_id from stock_movements where id = $1", [movement.id]);
    expect(rows).toEqual([{ actor_type: "user", actor_ref: auditorId, actor_user_id: auditorId }]);
    expect(JSON.stringify(rows)).not.toMatch(/auditor@|Test Auditor/);
  });

  it("stays truthful when the user's display name changes", async () => {
    await adjustStock(db, { sku, quantityDelta: 2, reason: "Recount", actor: actorFor(principal) });
    await pool.query("update auth_users set name = 'Renamed Auditor' where id = $1", [auditorId]);
    const [movement] = await listStockMovements(db, sku);
    expect(movement.actorRef).toBe(auditorId);
  });

  it("still records legacy system actors", async () => {
    const { movement } = await receiveStock(db, { sku, quantity: 1, actor: TEST_ACTOR });
    expect(movement).toMatchObject({ actorType: "system", actorRef: "integration-test", actorUserId: null });
  });

  it("refuses a user actor that did not come from a verified session", async () => {
    for (const forged of [
      { type: "user", ref: auditorId },
      Object.freeze({ type: "user", ref: auditorId }),
      { ...actorFor(principal) },
    ]) {
      expect(await errorCodeOf(receiveStock(db, { sku, quantity: 1, actor: forged as Actor }))).toBe("INVALID_INPUT");
    }
    expect(() => actorFor({ userId: auditorId, role: "owner" })).toThrow("principal from getPrincipal");
    expect((await listStockMovements(db, sku)).length).toBe(0);
  });

  it("cannot have its identity changed after it is issued", () => {
    const actor = actorFor(principal) as { ref: string };
    expect(() => {
      actor.ref = randomUUID();
    }).toThrow();
    expect(actor.ref).toBe(auditorId);
  });
});

describe("database rules for user actors", () => {
  it("rejects an unknown user, a mismatched reference and a system row that names a user", async () => {
    const stranger = randomUUID();
    expect(await errorCodeOf(insertMovement("user", stranger, stranger))).toBe("23503");
    expect(await errorCodeOf(insertMovement("user", randomUUID(), auditorId))).toBe("23514");
    expect(await errorCodeOf(insertMovement("user", auditorId, null))).toBe("23514");
    expect(await errorCodeOf(insertMovement("system", "integration-test", auditorId))).toBe("23514");
    expect(await errorCodeOf(insertMovement("user", "Test Auditor", null))).toBe("23514");
    expect(await errorCodeOf(insertMovement("admin", auditorId, auditorId))).toBe("23514");
  });

  it("keeps user-actor rows append-only and their user undeletable", async () => {
    const { movement } = await receiveStock(db, { sku, quantity: 1, actor: actorFor(principal) });
    expect(await errorCodeOf(pool.query("update stock_movements set actor_ref = 'integration-test' where id = $1", [movement.id]))).toBe("23001");
    expect(await errorCodeOf(pool.query("delete from stock_movements where id = $1", [movement.id]))).toBe("23001");
    // ON DELETE RESTRICT reports restrict_violation, from the ledger's foreign key (not from the trigger).
    const refused = await pool.query("delete from auth_users where id = $1", [auditorId]).then(
      () => null,
      (e: { code?: string; constraint?: string }) => e,
    );
    expect(refused).toMatchObject({ code: "23001", constraint: "stock_movements_actor_user_id_auth_users_id_fk" });
    expect((await pool.query("select 1 from auth_users where id = $1", [auditorId])).rowCount).toBe(1);
  });
});
