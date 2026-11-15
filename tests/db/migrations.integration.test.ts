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
      "cancellation_requests",
      "delivery_zones",
      "export_requests",
      "idempotency_records",
      "inventory_balances",
      "order_events",
      "order_items",
      "order_tracking_tokens",
      "orders",
      "payment_entries",
      "products",
      "quarantine_items",
      "return_items",
      "returns",
      "stock_count_lines",
      "stock_counts",
      "stock_movements",
      "stock_reservations",
      "tracking_rate_limits",
      "user_access",
      "variants",
    ]);

    const constraints = await client.query(
      `select conname from pg_constraint c join pg_namespace n on n.oid = c.connamespace
        where n.nspname = 'public' and contype in ('c', 'u', 'f') order by conname`,
    );
    // Compared as sets in code-point order, so the database collation does not matter.
    expect(constraints.rows.map((r) => r.conname).sort()).toEqual([
      "api_rate_limits_bucket_valid",
      "api_rate_limits_count_positive",
      "api_rate_limits_user_id_auth_users_id_fk",
      "auth_accounts_user_id_auth_users_id_fk",
      "auth_rate_limits_key_key",
      "auth_sessions_token_key",
      "auth_sessions_user_id_auth_users_id_fk",
      "auth_users_email_key",
      "auth_users_email_lowercase",
      "cancellation_requests_order_id_orders_id_fk",
      "cancellation_requests_reason_valid",
      "cancellation_requests_review_consistent",
      "cancellation_requests_reviewed_by_user_id_auth_users_id_fk",
      "cancellation_requests_status_valid",
      "delivery_zones_charge_range",
      "delivery_zones_code_valid",
      "delivery_zones_updated_by_user_id_auth_users_id_fk",
      "delivery_zones_version_positive",
      "export_requests_actor_user_id_auth_users_id_fk",
      "export_requests_dataset_valid",
      "export_requests_filters_object",
      "export_requests_format_valid",
      "export_requests_scope_valid",
      "idempotency_records_fingerprint_format",
      "idempotency_records_key_format",
      "idempotency_records_operation_format",
      "idempotency_records_result_object",
      "idempotency_records_user_id_auth_users_id_fk",
      "inventory_balances_on_hand_nonnegative",
      "inventory_balances_reserved_valid",
      "inventory_balances_variant_id_variants_id_fk",
      "order_events_actor_ref_format",
      "order_events_actor_type_valid",
      "order_events_actor_user_consistent",
      "order_events_actor_user_id_auth_users_id_fk",
      "order_events_detail_object",
      "order_events_event_format",
      "order_events_order_id_orders_id_fk",
      "order_items_amounts_valid",
      "order_items_name_present",
      "order_items_order_id_orders_id_fk",
      "order_items_quantity_range",
      "order_items_variant_id_variants_id_fk",
      "order_tracking_tokens_hash_format",
      "order_tracking_tokens_order_id_orders_id_fk",
      "order_tracking_tokens_token_hash_key",
      "orders_address_valid",
      "orders_amounts_valid",
      "orders_closed_after_return_window",
      "orders_closed_at_consistent",
      "orders_cod_amounts_valid",
      "orders_created_by_user_id_auth_users_id_fk",
      "orders_customer_name_valid",
      "orders_customer_phone_format",
      "orders_delivered_at_consistent",
      "orders_delivery_zone_delivery_zones_code_fk",
      "orders_fulfilment_consistent",
      "orders_fulfilment_status_valid",
      "orders_note_valid",
      "orders_number_key",
      "orders_payment_status_derived",
      "orders_return_status_valid",
      "orders_rto_charge_valid",
      "orders_source_valid",
      "orders_status_valid",
      "orders_version_positive",
      "payment_entries_actor_user_id_auth_users_id_fk",
      "payment_entries_amount_valid",
      "payment_entries_kind_valid",
      "payment_entries_method_valid",
      "payment_entries_order_id_orders_id_fk",
      "payment_entries_reference_valid",
      "payment_entries_refund_consistent",
      "payment_entries_return_id_returns_id_fk",
      "products_descriptions_valid",
      "products_name_present",
      "products_names_valid",
      "products_slug_format",
      "products_slug_key",
      "products_status_valid",
      "products_version_positive",
      "quarantine_items_inspected_by_user_id_auth_users_id_fk",
      "quarantine_items_inspection_consistent",
      "quarantine_items_note_valid",
      "quarantine_items_order_id_orders_id_fk",
      "quarantine_items_order_item_id_order_items_id_fk",
      "quarantine_items_quantity_positive",
      "quarantine_items_restock_movement_id_stock_movements_id_fk",
      "quarantine_items_restock_movement_key",
      "quarantine_items_return_id_returns_id_fk",
      "quarantine_items_return_link",
      "quarantine_items_source_valid",
      "quarantine_items_status_valid",
      "quarantine_items_variant_id_variants_id_fk",
      "return_items_order_item_id_order_items_id_fk",
      "return_items_quantity_positive",
      "return_items_return_id_returns_id_fk",
      "returns_created_by_user_id_auth_users_id_fk",
      "returns_dates_consistent",
      "returns_kind_valid",
      "returns_note_valid",
      "returns_order_id_orders_id_fk",
      "returns_reason_valid",
      "returns_shipping_cost_valid",
      "returns_shipping_responsibility",
      "returns_status_valid",
      "stock_count_lines_applied_consistent",
      "stock_count_lines_count_consistent",
      "stock_count_lines_count_id_stock_counts_id_fk",
      "stock_count_lines_counted_valid",
      "stock_count_lines_movement_id_stock_movements_id_fk",
      "stock_count_lines_movement_key",
      "stock_count_lines_snapshot_valid",
      "stock_count_lines_variant_id_variants_id_fk",
      "stock_counts_close_consistent",
      "stock_counts_closed_by_user_id_auth_users_id_fk",
      "stock_counts_created_by_user_id_auth_users_id_fk",
      "stock_counts_number_key",
      "stock_counts_reason_valid",
      "stock_counts_scope_valid",
      "stock_counts_status_valid",
      "stock_counts_version_positive",
      "stock_movements_actor_ref_format",
      "stock_movements_actor_type_valid",
      "stock_movements_actor_user_consistent",
      "stock_movements_actor_user_id_auth_users_id_fk",
      "stock_movements_delta_valid",
      "stock_movements_order_id_orders_id_fk",
      "stock_movements_order_link",
      "stock_movements_reason_valid",
      "stock_movements_type_valid",
      "stock_movements_variant_id_variants_id_fk",
      "stock_reservations_end_consistent",
      "stock_reservations_order_id_orders_id_fk",
      "stock_reservations_quantity_positive",
      "stock_reservations_status_valid",
      "stock_reservations_variant_id_variants_id_fk",
      "tracking_rate_limits_bucket_valid",
      "tracking_rate_limits_count_positive",
      "user_access_role_valid",
      "user_access_user_id_auth_users_id_fk",
      "variants_labels_valid",
      "variants_price_range",
      "variants_product_id_products_id_fk",
      "variants_sku_canonical",
      "variants_sku_key",
      "variants_status_valid",
      "variants_version_positive",
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
