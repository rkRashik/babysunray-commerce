import { describe, expect, it } from "vitest";
import {
  DROP_MANAGED_STATEMENTS,
  defaultDeviations,
  EVENT_TRIGGERS_SQL,
  unexpectedObjects,
} from "../support/schema-inventory";

// Unit tests for the parts of the reset preflight that cannot (or need not) run against PostgreSQL:
// the column-default comparison, the handling of the privileged event-trigger catalog, and the shape of
// the destructive statements. The catalog queries themselves are exercised against the real test
// database in reset-safety.integration.test.ts.

const row = (schema: string, rel: string, col: string, expr: string | null) => ({ schema, rel, col, expr });

describe("defaultDeviations", () => {
  it("accepts exactly the defaults the migrations create, and columns without a default", () => {
    expect(
      defaultDeviations([
        row("public", "products", "status", "'draft'::text"),
        row("public", "products", "created_at", "now()"),
        row("public", "products", "slug", null),
        row("public", "variants", "id", "gen_random_uuid()"),
        row("drizzle", "__drizzle_migrations", "id", "nextval('drizzle.__drizzle_migrations_id_seq'::regclass)"),
      ]),
    ).toEqual([]);
    expect(defaultDeviations([])).toEqual([]);
  });

  it("reports a changed, a dropped and an added default by column name only", () => {
    const deviations = defaultDeviations([
      row("public", "products", "status", "'private-changed-value'::text"),
      row("public", "products", "created_at", null),
      row("public", "products", "slug", "'private-added-value'::text"),
    ]);
    expect(deviations).toEqual([
      "default:public.products.status",
      "default:public.products.created_at",
      "default:public.products.slug",
    ]);
    expect(deviations.join(" ")).not.toContain("private-");
  });
});

describe("unexpectedObjects: event triggers", () => {
  // Event triggers need a superuser to create, so the test roles cannot plant one. The stub answers the
  // event-trigger query as PostgreSQL would and returns nothing for the other catalogs.
  const conn = (eventTriggers: string[]) =>
    ({
      query: async (sql: string) => ({ rows: sql === EVENT_TRIGGERS_SQL ? eventTriggers.map((evtname) => ({ evtname })) : [] }),
    }) as never;

  it("refuses when the database has an event trigger", async () => {
    expect(await unexpectedObjects(conn(["probe_evt_a", "probe_evt_b"]))).toEqual([
      "event_trigger:probe_evt_a",
      "event_trigger:probe_evt_b",
    ]);
  });

  it("accepts a database without event triggers", async () => {
    expect(await unexpectedObjects(conn([]))).toEqual([]);
  });
});

describe("destructive reset statements", () => {
  it("are RESTRICT-only, without CASCADE or TRUNCATE, and drop no schema except drizzle", () => {
    expect(DROP_MANAGED_STATEMENTS).toHaveLength(4);
    for (const statement of DROP_MANAGED_STATEMENTS) {
      expect(statement).toMatch(/ restrict;$/);
      expect(statement).not.toMatch(/cascade|truncate/i);
    }
    const schemaDrops = DROP_MANAGED_STATEMENTS.filter((s) => /drop schema/i.test(s));
    expect(schemaDrops).toEqual(['drop schema if exists "drizzle" restrict;']);
  });

  it("name every object with its schema", () => {
    const [tables, fn, history] = DROP_MANAGED_STATEMENTS;
    const tableList = tables.replace(/^drop table if exists /, "").replace(/ restrict;$/, "").split(", ");
    expect(tableList.sort()).toEqual([
      '"public"."api_rate_limits"',
      '"public"."auth_accounts"',
      '"public"."auth_rate_limits"',
      '"public"."auth_sessions"',
      '"public"."auth_users"',
      '"public"."auth_verifications"',
      '"public"."cancellation_requests"',
      '"public"."delivery_zones"',
      '"public"."export_requests"',
      '"public"."idempotency_records"',
      '"public"."inventory_balances"',
      '"public"."order_events"',
      '"public"."order_items"',
      '"public"."order_tracking_tokens"',
      '"public"."orders"',
      '"public"."payment_entries"',
      '"public"."products"',
      '"public"."quarantine_items"',
      '"public"."return_items"',
      '"public"."returns"',
      '"public"."stock_count_lines"',
      '"public"."stock_counts"',
      '"public"."stock_movements"',
      '"public"."stock_reservations"',
      '"public"."tracking_rate_limits"',
      '"public"."user_access"',
      '"public"."variants"',
    ]);
    expect(fn).toBe(
      'drop function if exists "public"."stock_movements_reject_change"(), "public"."user_access_revoke_sessions"(), "public"."append_only_reject_change"() restrict;',
    );
    expect(history).toBe('drop table if exists "drizzle"."__drizzle_migrations" restrict;');
  });
});
