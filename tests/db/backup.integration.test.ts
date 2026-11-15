import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertToolsMatch, backupDirectory, createBackupFile, dumpDatabase, verifyBackupFile } from "../../src/db/backup.mts";
import { parseSafeDatabaseUrl, TEST_TARGET } from "../../src/db/connection-guard.mts";
import { connectTestClient } from "../support/test-database";

// Encrypted backups of babysunray_test (non-destructive: nothing is restored here; the full restore is the
// separate `npm run backup:drill`). Files go to a new temporary directory outside the repository.

let dir: string;
let pgDumpVersion: string;
const passphrase = randomBytes(18).toString("base64url");
const conn = () => parseSafeDatabaseUrl(process.env.TEST_DATABASE_URL, TEST_TARGET);

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "babysunray-backup-test-"));
  const client = await connectTestClient();
  try {
    const { rows } = await client.query<{ v: string }>("show server_version_num");
    pgDumpVersion = await assertToolsMatch(Math.floor(Number(rows[0].v) / 10000));
  } finally {
    await client.end();
  }
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("encrypted backup", () => {
  it("writes an encrypted pg_dump archive that verifies, and detects a changed byte", async () => {
    const file = path.join(dir, "test.bsbackup");
    const { bytes } = await createBackupFile(conn(), passphrase, file, { pgDumpVersion });
    expect(bytes).toBeGreaterThan(1000);
    const raw = await readFile(file);
    expect(raw.includes(Buffer.from("PGDMP"))).toBe(false); // the pg_dump archive signature is never in clear
    expect(raw.includes(Buffer.from("CREATE TABLE"))).toBe(false);
    const verified = await verifyBackupFile(file, passphrase);
    expect(verified.entries.some((e) => / TABLE public orders /.test(e))).toBe(true);
    expect(verified.entries.some((e) => / TABLE DATA drizzle __drizzle_migrations /.test(e))).toBe(true);
    raw[raw.length - 100] ^= 0x01;
    const changed = path.join(dir, "changed.bsbackup");
    await writeFile(changed, raw);
    await expect(verifyBackupFile(changed, passphrase)).rejects.toThrow(/damaged/);
    expect(await readdir(dir)).toEqual(["changed.bsbackup", "test.bsbackup"]);
  });

  it("keeps all of pg_dump's output when it is read late (as after the key derivation)", { timeout: 60_000 }, async () => {
    // On Windows, output not read within a few hundred milliseconds could be lost entirely, with pg_dump still
    // exiting 0; a backup then held an empty archive.
    const sizes = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const { archive, done } = dumpDatabase(conn());
        await new Promise((r) => setTimeout(r, 1500));
        let n = 0;
        for await (const piece of archive) n += piece.length;
        await done;
        return n;
      }),
    );
    expect(Math.min(...sizes)).toBeGreaterThan(1000);
  });

  it("never overwrites a file and leaves no partial file when pg_dump fails", async () => {
    const file = path.join(dir, "test.bsbackup");
    await expect(createBackupFile(conn(), passphrase, file, { pgDumpVersion })).rejects.toThrow(/already exists/);
    const failing = path.join(dir, "failing.bsbackup");
    await expect(createBackupFile({ ...conn(), password: "not-the-password" }, passphrase, failing, { pgDumpVersion })).rejects.toThrow(/pg_dump failed/);
    expect((await readdir(dir)).filter((f) => f.startsWith("failing"))).toEqual([]);
    await expect(createBackupFile(conn(), "short", path.join(dir, "weak.bsbackup"), { pgDumpVersion })).rejects.toThrow(/at least 12/);
  });

  it("writes only to an existing directory outside the repository", async () => {
    const root = process.cwd();
    expect(await backupDirectory(dir, root)).toBeTruthy();
    await expect(backupDirectory(root, root)).rejects.toThrow(/inside the project/);
    await expect(backupDirectory(path.join(root, "src"), root)).rejects.toThrow(/inside the project/);
    await expect(backupDirectory("relative/dir", root)).rejects.toThrow(/absolute/);
    await expect(backupDirectory(path.join(dir, "missing"), root)).rejects.toThrow(/does not exist/);
    const nested = path.join(dir, "nested");
    await mkdir(nested);
    expect(await backupDirectory(nested, root)).toBeTruthy();
  });
});
