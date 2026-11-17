import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEV_TARGET, parseSafeDatabaseUrl, sessionConfig, TEST_TARGET } from "../../src/db/connection-guard.mts";
import { migrateVerified } from "../../src/db/migrate-verified.mts";
import { connectTestClient } from "../support/test-database";

// Drives the real boundary of `npm run db:migrate` (migrateVerified: identity check, search_path pin, then
// the migrator) against the isolated test database, with a one-statement probe migration that creates
// `probe_marker`. If the identity check or the pin stopped running, the probe table would appear where it
// must not, and these tests fail. The development database is never contacted.

const MARKER_WHEN = 4102444800000; // year 2100: later than every real migration, so the migrator treats it as pending

let client: Client;
let folder: string;
let params: ReturnType<typeof parseSafeDatabaseUrl>;

beforeAll(async () => {
  client = await connectTestClient();
  params = parseSafeDatabaseUrl(process.env.TEST_DATABASE_URL, TEST_TARGET);
  folder = mkdtempSync(path.join(tmpdir(), "bsr-probe-migration-"));
  mkdirSync(path.join(folder, "meta"));
  writeFileSync(
    path.join(folder, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: [{ idx: 0, version: "7", when: MARKER_WHEN, tag: "0000_probe_marker", breakpoints: true }],
    }),
  );
  writeFileSync(path.join(folder, "0000_probe_marker.sql"), 'create table "probe_marker" (n int);\n');
});

// Removes only what these tests create, whatever happened, so the next reset sees nothing unexpected.
async function cleanup() {
  await client.query(`
    drop table if exists probe_schema.probe_marker;
    drop table if exists public.probe_marker;
    delete from drizzle.__drizzle_migrations where created_at = ${MARKER_WHEN};
    drop schema if exists probe_schema;
  `);
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanup();
});

afterAll(async () => {
  await client?.end();
  rmSync(folder, { recursive: true, force: true });
});

async function probeLocations(): Promise<string[]> {
  const { rows } = await client.query<{ table_schema: string }>(
    "select table_schema from information_schema.tables where table_name = 'probe_marker' order by 1",
  );
  return rows.map((r) => r.table_schema);
}

async function probeRecorded(): Promise<boolean> {
  const { rows } = await client.query(`select 1 from drizzle.__drizzle_migrations where created_at = ${MARKER_WHEN}`);
  return rows.length > 0;
}

describe("migrateVerified: PostgreSQL-side identity check", () => {
  it("refuses a connection to the wrong database and runs no migration", async () => {
    // A real connection to babysunray_test, presented as the development target.
    await expect(migrateVerified(client, DEV_TARGET, folder)).rejects.toThrow("Connected database is not babysunray_dev");
    expect(await probeLocations()).toEqual([]);
    expect(await probeRecorded()).toBe(false);
  });

  it("runs the migration once the identity matches (so the refusal above is the check, not a broken probe)", async () => {
    await migrateVerified(client, TEST_TARGET, folder);
    expect(await probeLocations()).toEqual(["public"]);
    expect(await probeRecorded()).toBe(true);
  });
});

describe("migrateVerified: search_path", () => {
  it("applies unqualified migration SQL in public even when the session search_path points elsewhere", async () => {
    await client.query("create schema probe_schema");
    const hostile = new Client({ ...sessionConfig(params), options: "-c search_path=probe_schema" });
    await hostile.connect();
    try {
      // Control: the session really is hostile, and an unqualified create would land in probe_schema.
      expect((await hostile.query("show search_path")).rows[0].search_path).toBe("probe_schema");
      await migrateVerified(hostile, TEST_TARGET, folder);
    } finally {
      await hostile.end();
    }
    expect(await probeLocations()).toEqual(["public"]);
  });

  it("ignores PGOPTIONS: the startup option wins, while a client without it is redirected", async () => {
    vi.stubEnv("PGOPTIONS", "-c search_path=probe_schema");
    const search = async (config: ConstructorParameters<typeof Client>[0]) => {
      const c = new Client(config);
      await c.connect();
      try {
        return (await c.query("show search_path")).rows[0].search_path as string;
      } finally {
        await c.end();
      }
    };
    // Control: node-postgres does read PGOPTIONS when no options value is passed.
    expect(await search(params)).toBe("probe_schema");
    expect(await search(sessionConfig(params))).toBe("public");
  });
});

describe("concurrent runs", () => {
  // A slow probe that counts how often it ran: without the migration lock both runs read "not applied" before
  // either commits, and both apply it.
  const SLOW_WHEN = MARKER_WHEN + 1;
  let slowFolder: string;
  beforeAll(() => {
    slowFolder = mkdtempSync(path.join(tmpdir(), "bsr-probe-slow-"));
    mkdirSync(path.join(slowFolder, "meta"));
    writeFileSync(
      path.join(slowFolder, "meta", "_journal.json"),
      JSON.stringify({ version: "7", dialect: "postgresql", entries: [{ idx: 0, version: "7", when: SLOW_WHEN, tag: "0000_probe_slow", breakpoints: true }] }),
    );
    writeFileSync(path.join(slowFolder, "0000_probe_slow.sql"), 'select pg_sleep(0.5);\n--> statement-breakpoint\ninsert into "probe_runs" (n) values (1);\n');
  });
  afterAll(async () => {
    await client.query(`drop table if exists public.probe_runs; delete from drizzle.__drizzle_migrations where created_at = ${SLOW_WHEN};`);
    rmSync(slowFolder, { recursive: true, force: true });
  });

  it("apply a pending migration once: the second run waits for the first, then finds nothing to do", async () => {
    await client.query('create table "probe_runs" (n int)');
    const [a, b] = [await connectTestClient(), await connectTestClient()];
    try {
      await Promise.all([migrateVerified(a, TEST_TARGET, slowFolder), migrateVerified(b, TEST_TARGET, slowFolder)]);
    } finally {
      await Promise.all([a.end(), b.end()]);
    }
    expect((await client.query("select count(*)::int as n from probe_runs")).rows[0].n).toBe(1);
    expect((await client.query(`select count(*)::int as n from drizzle.__drizzle_migrations where created_at = ${SLOW_WHEN}`)).rows[0].n).toBe(1);
    // The lock is released afterwards.
    expect((await client.query("select count(*)::int as n from pg_locks where locktype = 'advisory' and classid = 1651725938 and objid = 2")).rows[0].n).toBe(0);
  });
});
