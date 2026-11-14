import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAndMigrate } from "../support/global-setup";
import { expectedObjects, unexpectedObjects } from "../support/schema-inventory";
import { connectTestClient } from "../support/test-database";

// The destructive test reset must stop, changing nothing, when the test database holds anything the
// migrations do not create. Each case plants one foreign object or one piece of metadata in
// babysunray_test (never anywhere else), plants a row to prove data survives, runs the reset, removes
// what it planted, and checks the database is back to exactly what the migrations create.
//
// Not planted here: an event trigger, which needs a superuser (covered with a stubbed catalog result in
// schema-inventory.test.ts).

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
    name: "column on an authentication table",
    plant: "alter table auth_users add column probe_col int",
    remove: "alter table auth_users drop column if exists probe_col",
    listed: "column:public.auth_users.probe_col",
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
    name: "extended statistics object",
    plant: "create statistics probe_stat on slug, name_en from products",
    remove: "drop statistics if exists probe_stat",
    listed: "statistics:public.probe_stat",
    stillThere: "select 1 from pg_statistic_ext where stxname = 'probe_stat'",
  },
  {
    name: "publication that includes a managed table",
    plant: "create publication probe_pub for table products",
    remove: "drop publication if exists probe_pub",
    listed: "publication_table:public.products:probe_pub",
    stillThere: "select 1 from pg_publication where pubname = 'probe_pub'",
  },
  {
    name: "table privilege",
    plant: "grant select on products to public",
    remove: "revoke select on products from public",
    listed: "acl:public.products",
    stillThere:
      "select 1 from pg_class where oid = 'public.products'::regclass and relacl is not null and relacl::text <> acldefault('r'::\"char\", relowner)::text",
  },
  {
    name: "sequence privilege",
    plant: "grant usage on sequence stock_movements_id_seq to public",
    remove: "revoke usage on sequence stock_movements_id_seq from public",
    listed: "acl:public.stock_movements_id_seq",
    stillThere:
      "select 1 from pg_class where oid = 'public.stock_movements_id_seq'::regclass and relacl is not null and relacl::text <> acldefault('s'::\"char\", relowner)::text",
  },
  {
    name: "column privilege",
    plant: "grant select (slug) on products to public",
    remove: "revoke select (slug) on products from public",
    listed: "column_acl:public.products.slug",
    stillThere:
      "select 1 from pg_attribute where attrelid = 'public.products'::regclass and attname = 'slug' and attacl is not null",
  },
  {
    name: "function privilege",
    plant: "revoke execute on function stock_movements_reject_change() from public",
    remove: "grant execute on function stock_movements_reject_change() to public",
    listed: "function_acl:public.stock_movements_reject_change",
    stillThere:
      "select 1 from pg_proc where oid = 'public.stock_movements_reject_change()'::regprocedure and proacl is not null and proacl::text <> acldefault('f'::\"char\", proowner)::text",
  },
  {
    name: "privilege on the migration history schema",
    plant: "grant usage on schema drizzle to public",
    remove: "revoke usage on schema drizzle from public",
    listed: "schema_acl:drizzle",
    stillThere: "select 1 from pg_namespace where nspname = 'drizzle' and nspacl is not null",
  },
  {
    name: "default privilege setting",
    plant: "alter default privileges in schema public grant select on tables to public",
    remove: "alter default privileges in schema public revoke select on tables from public",
    listed: "default_acl:babysunray_test:r",
    stillThere: "select 1 from pg_default_acl",
  },
  {
    name: "comment on a table",
    plant: "comment on table products is 'probe'",
    remove: "comment on table products is null",
    listed: "comment:relation:public.products",
    stillThere: "select 1 from pg_description where objoid = 'public.products'::regclass and objsubid = 0",
  },
  {
    name: "comment on a column",
    plant: "comment on column products.slug is 'probe'",
    remove: "comment on column products.slug is null",
    listed: "comment:column:public.products.slug",
    stillThere: "select 1 from pg_description where objoid = 'public.products'::regclass and objsubid > 0",
  },
  {
    name: "comment on a constraint",
    plant: "comment on constraint products_slug_key on products is 'probe'",
    remove: "comment on constraint products_slug_key on products is null",
    listed: "comment:constraint:public.products.products_slug_key",
    stillThere:
      "select 1 from pg_description where objoid = (select oid from pg_constraint where conname = 'products_slug_key')",
  },
  {
    name: "comment on the append-only trigger",
    plant: "comment on trigger stock_movements_append_only on stock_movements is 'probe'",
    remove: "comment on trigger stock_movements_append_only on stock_movements is null",
    listed: "comment:trigger:public.stock_movements.stock_movements_append_only",
    stillThere:
      "select 1 from pg_description where objoid = (select oid from pg_trigger where tgname = 'stock_movements_append_only')",
  },
  {
    name: "comment on the ledger function",
    plant: "comment on function stock_movements_reject_change() is 'probe'",
    remove: "comment on function stock_movements_reject_change() is null",
    listed: "comment:function:public.stock_movements_reject_change",
    stillThere:
      "select 1 from pg_description where objoid = 'public.stock_movements_reject_change()'::regprocedure",
  },
  {
    name: "comment on the migration history schema",
    plant: "comment on schema drizzle is 'probe'",
    remove: "comment on schema drizzle is null",
    listed: "comment:schema:drizzle",
    stillThere: "select 1 from pg_description where objoid = 'drizzle'::regnamespace",
  },
  {
    name: "changed column default",
    plant: "alter table products alter column status set default 'archived'",
    remove: "alter table products alter column status set default 'draft'",
    listed: "default:public.products.status",
    stillThere:
      "select 1 from pg_attrdef where adrelid = 'public.products'::regclass and pg_get_expr(adbin, adrelid) like '%archived%'",
  },
  {
    name: "dropped column default",
    plant: "alter table products alter column created_at drop default",
    remove: "alter table products alter column created_at set default now()",
    listed: "default:public.products.created_at",
    stillThere:
      "select 1 from pg_attribute a where a.attrelid = 'public.products'::regclass and a.attname = 'created_at' and not exists (select 1 from pg_attrdef d where d.adrelid = a.attrelid and d.adnum = a.attnum)",
  },
  {
    name: "added column default",
    plant: "alter table products alter column slug set default 'probe'",
    remove: "alter table products alter column slug drop default",
    listed: "default:public.products.slug",
    stillThere:
      "select 1 from pg_attrdef where adrelid = 'public.products'::regclass and pg_get_expr(adbin, adrelid) = '''probe''::text'",
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
    // The cleanup restored exactly what the migrations create (for example, a revoked privilege that
    // leaves an owner-only ACL behind is not reported).
    expect(await unexpectedObjects(client)).toEqual([]);
  });

  it("names unexpected metadata without printing its values", async () => {
    await client.query("alter table products alter column slug set default 'probe-private-default'");
    await client.query("comment on table variants is 'probe-private-comment'");
    try {
      const error = await resetAndMigrate(process.env.TEST_DATABASE_URL).then(
        () => "",
        (e: Error) => e.message,
      );
      expect(error).toContain("default:public.products.slug");
      expect(error).toContain("comment:relation:public.variants");
      expect(error).not.toContain("probe-private");
    } finally {
      await client.query("alter table products alter column slug drop default");
      await client.query("comment on table variants is null");
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

  it("replays normally once every planted object and piece of metadata is gone", async () => {
    expect(await unexpectedObjects(client)).toEqual([]);
    await client.query("insert into products (slug, name_en) values ('reset-final', 'Probe')");
    await resetAndMigrate(process.env.TEST_DATABASE_URL);
    expect(await exists("select 1 from products where slug = 'reset-final'")).toBe(false);
    expect(await unexpectedObjects(client)).toEqual([]);
  });
});
