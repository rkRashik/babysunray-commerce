import { readFileSync } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAndMigrate } from "../support/global-setup";
import { connectTestClient } from "../support/test-database";

const journal = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../../drizzle/meta/_journal.json"), "utf8"),
) as { entries: { tag: string; when: number }[] };

let client: Client;

beforeAll(async () => {
  client = await connectTestClient();
});

afterAll(async () => {
  await client?.end();
});

async function appliedMigrations(): Promise<number[]> {
  const { rows } = await client.query<{ created_at: string }>(
    "select created_at from drizzle.__drizzle_migrations order by id",
  );
  return rows.map((r) => Number(r.created_at));
}

describe("migrations", () => {
  it("applied every committed migration, in order, to a fresh schema", async () => {
    expect(await appliedMigrations()).toEqual(journal.entries.map((e) => e.when));
  });

  it("created the expected tables, constraints and ledger trigger", async () => {
    const tables = await client.query(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      "api_rate_limits",
      "auth_accounts",
      "auth_rate_limits",
      "auth_sessions",
      "auth_users",
      "auth_verifications",
      "idempotency_records",
      "inventory_balances",
      "products",
      "stock_movements",
      "user_access",
      "variants",
    ]);

    const constraints = await client.query(
      `select conname from pg_constraint c join pg_namespace n on n.oid = c.connamespace
        where n.nspname = 'public' and contype in ('c', 'u', 'f') order by conname`,
    );
    expect(constraints.rows.map((r) => r.conname)).toEqual([
      "api_rate_limits_bucket_valid",
      "api_rate_limits_count_positive",
      "api_rate_limits_user_id_auth_users_id_fk",
      "auth_accounts_user_id_auth_users_id_fk",
      "auth_rate_limits_key_key",
      "auth_sessions_token_key",
      "auth_sessions_user_id_auth_users_id_fk",
      "auth_users_email_key",
      "auth_users_email_lowercase",
      "idempotency_records_fingerprint_format",
      "idempotency_records_key_format",
      "idempotency_records_operation_format",
      "idempotency_records_result_object",
      "idempotency_records_user_id_auth_users_id_fk",
      "inventory_balances_on_hand_nonnegative",
      "inventory_balances_variant_id_variants_id_fk",
      "products_descriptions_valid",
      "products_name_present",
      "products_names_valid",
      "products_slug_format",
      "products_slug_key",
      "products_status_valid",
      "stock_movements_actor_ref_format",
      "stock_movements_actor_type_valid",
      "stock_movements_actor_user_consistent",
      "stock_movements_actor_user_id_auth_users_id_fk",
      "stock_movements_delta_valid",
      "stock_movements_reason_valid",
      "stock_movements_type_valid",
      "stock_movements_variant_id_variants_id_fk",
      "user_access_role_valid",
      "user_access_user_id_auth_users_id_fk",
      "variants_labels_valid",
      "variants_price_range",
      "variants_product_id_products_id_fk",
      "variants_sku_canonical",
      "variants_sku_key",
      "variants_status_valid",
    ]);

    const trigger = await client.query(
      "select tgenabled from pg_trigger where tgname = 'stock_movements_append_only' and not tgisinternal",
    );
    expect(trigger.rows).toEqual([{ tgenabled: "O" }]);
    const revoke = await client.query(
      "select tgenabled from pg_trigger where tgname = 'user_access_revoke_sessions' and not tgisinternal",
    );
    expect(revoke.rows).toEqual([{ tgenabled: "O" }]);
  });

  it("is a no-op when run again on an up-to-date schema", async () => {
    await migrate(drizzle({ client }), { migrationsFolder: path.resolve(import.meta.dirname, "../../drizzle") });
    expect(await appliedMigrations()).toHaveLength(journal.entries.length);
  });

  it("replays from scratch, and stops without changes when the database holds unknown objects", async () => {
    await resetAndMigrate(process.env.TEST_DATABASE_URL);
    expect(await appliedMigrations()).toEqual(journal.entries.map((e) => e.when));

    await client.query("insert into products (slug, name_en) values ('mig-keep', 'Kept')");
    await client.query("create table unexpected_probe (n int)");
    try {
      await expect(resetAndMigrate(process.env.TEST_DATABASE_URL)).rejects.toThrow("relation:public.unexpected_probe:r");
      const kept = await client.query("select count(*)::int as n from products where slug = 'mig-keep'");
      expect(kept.rows[0].n).toBe(1);
    } finally {
      await client.query("drop table unexpected_probe");
    }
  });
});
