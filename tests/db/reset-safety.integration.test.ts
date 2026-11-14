import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAndMigrate } from "../support/global-setup";
import { expectedObjects, unexpectedObjects } from "../support/schema-inventory";
import { connectTestClient } from "../support/test-database";

// The destructive test reset must stop, changing nothing, when the test database holds anything the
// migrations do not create. Each case plants one foreign object in babysunray_test (never anywhere else),
// plants a row to prove data survives, runs the reset, and removes what it planted.

let client: Client;

beforeAll(async () => {
  client = await connectTestClient();
  await resetAndMigrate(process.env.TEST_DATABASE_URL);
});

afterAll(async () => {
  await client?.end();
});

async function exists(sql: string): Promise<boolean> {
  const { rows } = await client.query(sql);
  return rows.length > 0;
}

const CASES: { name: string; plant: string; remove: string; listed: string; stillThere: string }[] = [
  {
    name: "table",
    plant: "create table probe_table (n int)",
    remove: "drop table if exists probe_table",
    listed: "relation:public.probe_table:r",
    stillThere: "select 1 from pg_class where relname = 'probe_table'",
  },
  {
    name: "index on a managed table",
    plant: "create index probe_index on products (name_en)",
    remove: "drop index if exists probe_index",
    listed: "relation:public.probe_index:i",
    stillThere: "select 1 from pg_class where relname = 'probe_index'",
  },
  {
    name: "trigger on a managed table",
    // Reuses the managed function: the trigger is the only foreign object.
    plant:
      "create trigger probe_trigger before delete on products for each row execute function stock_movements_reject_change()",
    remove: "drop trigger if exists probe_trigger on products",
    listed: "trigger:public.products.probe_trigger",
    stillThere: "select 1 from pg_trigger where tgname = 'probe_trigger'",
  },
  {
    name: "constraint on a managed table",
    plant: "alter table products add constraint probe_check check (length(slug) > 0)",
    remove: "alter table products drop constraint if exists probe_check",
    listed: "constraint:public.products.probe_check",
    stillThere: "select 1 from pg_constraint where conname = 'probe_check'",
  },
  {
    name: "foreign key from an unknown table to a managed table",
    plant: "create table probe_child (p uuid constraint probe_fk references products (id))",
    remove: "drop table if exists probe_child",
    listed: "constraint:public.probe_child.probe_fk",
    stillThere: "select 1 from pg_constraint where conname = 'probe_fk'",
  },
  {
    name: "view that depends on a managed table",
    plant: "create view probe_view as select id from products",
    remove: "drop view if exists probe_view",
    listed: "relation:public.probe_view:v",
    stillThere: "select 1 from pg_class where relname = 'probe_view'",
  },
  {
    name: "materialized view that depends on a managed table",
    plant: "create materialized view probe_matview as select id from products",
    remove: "drop materialized view if exists probe_matview",
    listed: "relation:public.probe_matview:m",
    stillThere: "select 1 from pg_class where relname = 'probe_matview'",
  },
  {
    name: "column on a managed table",
    plant: "alter table products add column probe_col int",
    remove: "alter table products drop column if exists probe_col",
    listed: "column:public.products.probe_col",
    stillThere: "select 1 from pg_attribute where attname = 'probe_col' and not attisdropped",
  },
  {
    name: "sequence",
    plant: "create sequence probe_seq",
    remove: "drop sequence if exists probe_seq",
    listed: "relation:public.probe_seq:S",
    stillThere: "select 1 from pg_class where relname = 'probe_seq'",
  },
  {
    name: "function",
    plant: "create function probe_fn() returns int language sql as 'select 1'",
    remove: "drop function if exists probe_fn()",
    listed: "function:public.probe_fn",
    stillThere: "select 1 from pg_proc where proname = 'probe_fn'",
  },
  {
    name: "enum type",
    plant: "create type probe_type as enum ('a')",
    remove: "drop type if exists probe_type",
    listed: "type:public.probe_type",
    stillThere: "select 1 from pg_type where typname = 'probe_type'",
  },
  {
    name: "rule on a managed table",
    plant: "create rule probe_rule as on insert to inventory_balances do instead nothing",
    remove: "drop rule if exists probe_rule on inventory_balances",
    listed: "rule:public.inventory_balances.probe_rule",
    stillThere: "select 1 from pg_rewrite where rulename = 'probe_rule'",
  },
  {
    name: "extra schema",
    plant: "create schema probe_schema",
    remove: "drop schema if exists probe_schema",
    listed: "schema:probe_schema",
    stillThere: "select 1 from pg_namespace where nspname = 'probe_schema'",
  },
  {
    name: "object in the migration history schema",
    plant: "create table drizzle.probe_history (n int)",
    remove: "drop table if exists drizzle.probe_history",
    listed: "relation:drizzle.probe_history:r",
    stillThere: "select 1 from pg_class where relname = 'probe_history'",
  },
];

describe("destructive test reset preflight", () => {
  it("accepts exactly the objects the migrations create", async () => {
    expect(await unexpectedObjects(client)).toEqual([]);
    // The inventory is not trivially empty: the expected set includes the tables, trigger and migration history.
    const expected = expectedObjects();
    for (const object of [
      "relation:public.variants:r",
      "constraint:public.variants.variants_sku_canonical",
      "relation:public.stock_movements_variant_id_id_idx:i",
      "trigger:public.stock_movements.stock_movements_append_only",
      "relation:drizzle.__drizzle_migrations:r",
    ]) {
      expect(expected.has(object), object).toBe(true);
    }
  });

  it("still replays migrations on a database that holds only migration-created objects and data", async () => {
    await client.query("insert into products (slug, name_en) values ('reset-keep-ok', 'Probe')");
    await resetAndMigrate(process.env.TEST_DATABASE_URL);
    expect(await exists("select 1 from products where slug = 'reset-keep-ok'")).toBe(false);
    const { rows } = await client.query("select count(*)::int as n from drizzle.__drizzle_migrations");
    expect(rows[0].n).toBeGreaterThanOrEqual(3);
  });

  it.each(CASES)("stops and changes nothing when an unexpected $name exists", async (c) => {
    await client.query("insert into products (slug, name_en) values ('reset-keep', 'Probe')");
    await client.query(c.plant);
    try {
      expect(await unexpectedObjects(client)).toContain(c.listed);
      await expect(resetAndMigrate(process.env.TEST_DATABASE_URL)).rejects.toThrow(
        /objects the migrations do not create .* Stopping without changing anything/,
      );
      // Nothing was dropped: the planted object, the managed data and the migration history are all intact.
      expect(await exists(c.stillThere)).toBe(true);
      expect(await exists("select 1 from products where slug = 'reset-keep'")).toBe(true);
      expect(await exists("select 1 from drizzle.__drizzle_migrations")).toBe(true);
      expect(await exists("select 1 from pg_trigger where tgname = 'stock_movements_append_only'")).toBe(true);
    } finally {
      await client.query(c.remove);
      await client.query("delete from products where slug = 'reset-keep'");
    }
  });

  it("reports the unexpected objects without printing connection details", async () => {
    await client.query("create table probe_message (n int)");
    try {
      const error = await resetAndMigrate(process.env.TEST_DATABASE_URL).then(
        () => "",
        (e: Error) => e.message,
      );
      expect(error).toContain("relation:public.probe_message:r");
      expect(error).not.toContain("postgres");
      expect(error).not.toMatch(/password|@localhost/i);
    } finally {
      await client.query("drop table if exists probe_message");
    }
  });
});
