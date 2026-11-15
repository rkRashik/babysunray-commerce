// Encrypted logical backups of a local PostgreSQL database (requirements K-1, K-4 local part, K-6). Plain
// TypeScript (no aliases, no server-only) so the CLIs in scripts/ can run it with Node directly. Not imported
// by the application.
//
// A backup is pg_dump's custom-format archive (schema, data, sequences, triggers and the migration history),
// streamed straight into encryption: no plaintext dump is ever written to disk. The file format:
//
//   "BSRBAK01" | uint32 header length | header (JSON, UTF-8) | records ...
//   record   = uint8 flags (1 = final) | uint32 ciphertext length | ciphertext | 16-byte GCM tag
//
// Each record is at most 64 KiB of plaintext, encrypted with AES-256-GCM (Node's OpenSSL). The key is derived
// from the operator's passphrase with scrypt (salt and cost in the header). The nonce is a random 7-byte prefix,
// the record number and the final flag; the header is the additional authenticated data of every record. So
// every record is authenticated before any of its plaintext is used, and changing, reordering, removing or
// adding records, cutting the file short or editing the header is detected (the "STREAM" construction of
// Hoang, Reyhanitabar, Rogaway and Vizár, 2015, built from standard primitives; no primitive is custom).
//
// What this does not protect: the header (database name, times, cost parameters) is readable without the
// passphrase, and anyone with the passphrase can read the whole backup. Losing the passphrase loses the backup.

import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, rename, rm, stat } from "node:fs/promises";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

export const MAGIC = Buffer.from("BSRBAK01", "ascii");
export const FORMAT_VERSION = 1;
const CHUNK = 64 * 1024;
const TAG = 16;
const KDF = { N: 2 ** 17, r: 8, p: 1 };
const MAX_HEADER = 16 * 1024;
export const MIN_PASSPHRASE = 12;

export type BackupHeader = {
  format: "babysunray-backup";
  version: number;
  createdAt: string;
  database: string;
  archive: "pg_dump custom format";
  pgDumpVersion: string;
  excludedTableData: string[];
  cipher: "AES-256-GCM";
  chunkSize: number;
  noncePrefix: string;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
};

// Credentials and counters a restored system must not inherit: session tokens (a restored copy would otherwise
// carry live sign-ins), verification tokens and rate-limit windows. Their tables (schema) are still backed up.
export const EXCLUDED_TABLE_DATA = ["auth_sessions", "auth_verifications", "auth_rate_limits", "api_rate_limits", "tracking_rate_limits"];

export function checkPassphrase(passphrase: string): string {
  const normalised = passphrase.normalize("NFC");
  if ([...normalised].length < MIN_PASSPHRASE) throw new Error(`The backup passphrase must be at least ${MIN_PASSPHRASE} characters.`);
  return normalised;
}

const deriveKey = (passphrase: string, salt: Buffer, kdf: { N: number; r: number; p: number }) =>
  scrypt(checkPassphrase(passphrase), salt, 32, { ...kdf, maxmem: 256 * 1024 * 1024 });

function nonce(prefix: Buffer, counter: number, final: boolean): Buffer {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeUInt32BE(counter, 7);
  n[11] = final ? 1 : 0;
  return n;
}

/** Re-chunks a byte stream into pieces of exactly `size` bytes (the last may be shorter or empty). */
async function* rechunk(input: AsyncIterable<Uint8Array>, size: number): AsyncGenerator<Buffer> {
  let pending = Buffer.alloc(0);
  for await (const piece of input) {
    pending = pending.length ? Buffer.concat([pending, Buffer.from(piece)]) : Buffer.from(piece);
    while (pending.length >= size) {
      yield pending.subarray(0, size);
      pending = pending.subarray(size);
    }
  }
  yield pending;
}

export async function* encryptStream(input: AsyncIterable<Uint8Array>, passphrase: string, meta: Pick<BackupHeader, "createdAt" | "database" | "pgDumpVersion">): AsyncGenerator<Buffer> {
  yield* sealStream(input, passphrase, { format: "babysunray-backup", version: FORMAT_VERSION, ...meta, archive: "pg_dump custom format", excludedTableData: EXCLUDED_TABLE_DATA });
}

/** The cipher fields every sealed file's header carries (the rest of the header is the caller's description). */
export type SealFields = { cipher: "AES-256-GCM"; chunkSize: number; noncePrefix: string; kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string } };

/**
 * Encrypts a byte stream into the sealed format described at the top of this file, with `describe` (format name,
 * version and other plain facts) as the readable, authenticated header. Shared by database and photo backups.
 */
export async function* sealStream(input: AsyncIterable<Uint8Array>, passphrase: string, describe: Record<string, unknown> & { format: string; version: number }): AsyncGenerator<Buffer> {
  const salt = randomBytes(16);
  const prefix = randomBytes(7);
  const header = {
    ...describe,
    cipher: "AES-256-GCM",
    chunkSize: CHUNK,
    noncePrefix: prefix.toString("base64"),
    kdf: { name: "scrypt", ...KDF, salt: salt.toString("base64") },
  };
  const key = await deriveKey(passphrase, salt, KDF);
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(headerBytes.length);
  yield Buffer.concat([MAGIC, length, headerBytes]);
  let counter = 0;
  let previous: Buffer | null = null;
  // One chunk of look-ahead, so the last record (possibly empty) carries the final flag.
  for await (const chunk of rechunk(input, CHUNK)) {
    if (previous) yield seal(key, prefix, headerBytes, counter++, false, previous);
    previous = chunk;
  }
  yield seal(key, prefix, headerBytes, counter, true, previous ?? Buffer.alloc(0));
}

function seal(key: Buffer, prefix: Buffer, aad: Buffer, counter: number, final: boolean, plaintext: Buffer): Buffer {
  if (counter > 0xffffffff) throw new Error("Backup is too large for this format.");
  const cipher = createCipheriv("aes-256-gcm", key, nonce(prefix, counter, final));
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const head = Buffer.alloc(5);
  head[0] = final ? 1 : 0;
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body, cipher.getAuthTag()]);
}

/** Reads exactly n bytes at a time, or fewer at the end of the input. */
function reader(source: AsyncIterator<Uint8Array>) {
  let buffer = Buffer.alloc(0);
  let done = false;
  return async (n: number): Promise<Buffer> => {
    while (buffer.length < n && !done) {
      const next = await source.next();
      if (next.done) done = true;
      else buffer = Buffer.concat([buffer, Buffer.from(next.value)]);
    }
    const out = buffer.subarray(0, n);
    buffer = buffer.subarray(out.length);
    return out;
  };
}

const INVALID = "The backup file is damaged, was changed, or the passphrase is wrong.";

/** The cipher fields this version writes; anything else (including costlier KDF parameters) is refused. */
function sealFieldsOk(h: Partial<SealFields>): boolean {
  return (
    h.cipher === "AES-256-GCM" &&
    h.chunkSize === CHUNK &&
    h.kdf?.name === "scrypt" &&
    h.kdf.N === KDF.N &&
    h.kdf.r === KDF.r &&
    h.kdf.p === KDF.p &&
    Buffer.from(h.kdf.salt ?? "", "base64").length === 16 &&
    Buffer.from(h.noncePrefix ?? "", "base64").length === 7
  );
}

function parseHeader<H>(bytes: Buffer, check: (header: Record<string, unknown>) => boolean, kind: string): H & SealFields {
  let h: Record<string, unknown>;
  try {
    h = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(INVALID);
  }
  // Fail closed on anything this version does not write (including cost parameters that could exhaust memory).
  if (!h || typeof h !== "object" || !sealFieldsOk(h as Partial<SealFields>) || !check(h)) throw new Error(`This is not a ${kind} this version can read.`);
  return h as H & SealFields;
}

const isDatabaseBackup = (h: Record<string, unknown>) => h.format === "babysunray-backup" && h.version === FORMAT_VERSION;

/**
 * Opens a backup: checks the header, derives the key and returns the plaintext as a stream whose every piece
 * was authenticated before it is yielded. The stream throws (and yields nothing further) at the first bad or
 * missing record, so a consumer must treat an exception as "the backup is unusable".
 */
export function openBackup(input: AsyncIterable<Uint8Array>, passphrase: string): Promise<{ header: BackupHeader; plaintext: AsyncGenerator<Buffer> }> {
  return openSealed<BackupHeader>(input, passphrase, isDatabaseBackup, "database backup");
}

/** openBackup for any sealed format: `check` accepts the header's own fields (format name and version). */
export async function openSealed<H>(
  input: AsyncIterable<Uint8Array>,
  passphrase: string,
  check: (header: Record<string, unknown>) => boolean,
  kind: string,
): Promise<{ header: H & SealFields; plaintext: AsyncGenerator<Buffer> }> {
  const read = reader(input[Symbol.asyncIterator]());
  const magic = await read(MAGIC.length);
  if (!magic.equals(MAGIC)) throw new Error("This is not a backup file.");
  const lengthBytes = await read(4);
  if (lengthBytes.length !== 4) throw new Error(INVALID);
  const length = lengthBytes.readUInt32BE(0);
  if (length === 0 || length > MAX_HEADER) throw new Error(INVALID);
  const headerBytes = await read(length);
  if (headerBytes.length !== length) throw new Error(INVALID);
  const header = parseHeader<H>(headerBytes, check, kind);
  const key = await deriveKey(passphrase, Buffer.from(header.kdf.salt, "base64"), header.kdf);
  const prefix = Buffer.from(header.noncePrefix, "base64");
  async function* plaintext(): AsyncGenerator<Buffer> {
    for (let counter = 0; ; counter += 1) {
      const head = await read(5);
      if (head.length !== 5) throw new Error(INVALID); // cut short before the final record
      const final = head[0] === 1;
      const size = head.readUInt32BE(1);
      if (head[0] > 1 || size > CHUNK) throw new Error(INVALID);
      const body = await read(size + TAG);
      if (body.length !== size + TAG) throw new Error(INVALID);
      const decipher = createDecipheriv("aes-256-gcm", key, nonce(prefix, counter, final));
      decipher.setAAD(headerBytes);
      decipher.setAuthTag(body.subarray(size));
      let clear: Buffer;
      try {
        clear = Buffer.concat([decipher.update(body.subarray(0, size)), decipher.final()]);
      } catch {
        throw new Error(INVALID);
      }
      if (clear.length) yield clear;
      if (final) {
        if ((await read(1)).length !== 0) throw new Error(INVALID); // data after the final record
        return;
      }
    }
  }
  return { header, plaintext: plaintext() };
}

// ---------------------------------------------------------------------------------------------------------
// pg_dump and pg_restore. The password reaches them only through the PGPASSWORD environment variable of the
// child process (never an argument, so it is not in process listings); every other PG* variable is removed so
// nothing can redirect the connection. Tools are taken from PG_BIN (a directory) or the PATH.

export type Connection = { host: string; port: number; database: string; user: string; password?: string };

function childEnv(conn: Connection): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(process.env)) if (!/^PG/i.test(name)) env[name] = value;
  if (conn.password) env.PGPASSWORD = conn.password;
  env.PGCONNECT_TIMEOUT = "10";
  return env as NodeJS.ProcessEnv;
}

const tool = (name: "pg_dump" | "pg_restore") => (process.env.PG_BIN ? `${process.env.PG_BIN.replace(/[\\/]+$/, "")}/${name}` : name);
const connectionArgs = (conn: Connection) => ["--host", conn.host, "--port", String(conn.port), "--username", conn.user, "--no-password"];

/** Runs a tool with stdin and stdout as given; resolves with stderr (shortened) or rejects naming the tool and code. */
function run(name: "pg_dump" | "pg_restore", args: string[], conn: Connection, stdin?: AsyncIterable<Uint8Array>) {
  const child = spawn(tool(name), args, { env: childEnv(conn), stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"], windowsHide: true });
  if (!child.stdout || !child.stderr) throw new Error(`${name} could not be started.`);
  const stdout = child.stdout;
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
  const exited = new Promise<void>((resolve, reject) => {
    child.on("error", (error) => reject(new Error(`${name} could not be started (${(error as NodeJS.ErrnoException).code ?? error.name}). Set PG_BIN to PostgreSQL's bin directory.`)));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${name} failed (exit code ${code}): ${stderr.trim().split("\n").slice(-3).join(" ")}`))));
  });
  let fed: Promise<void> = Promise.resolve();
  if (stdin && child.stdin) {
    const sink = child.stdin;
    fed = (async () => {
      try {
        for await (const chunk of stdin) if (!sink.write(chunk)) await new Promise((r) => sink.once("drain", r));
        sink.end();
      } catch (error) {
        // A bad record: stop the tool before it can finish with partial input.
        child.kill();
        throw error;
      }
    })();
    sink.on("error", () => {});
  }
  const done = Promise.all([exited, fed]).then(() => stderr);
  done.catch(() => {}); // the caller awaits it after reading stdout; never reported as unhandled meanwhile
  return { child, stdout, done };
}

export async function toolVersion(name: "pg_dump" | "pg_restore"): Promise<{ text: string; major: number }> {
  const { stdout, done } = run(name, ["--version"], { host: "", port: 0, database: "", user: "" });
  let text = "";
  for await (const d of stdout) text += d.toString();
  await done;
  const match = /\(PostgreSQL\)\s+(\d+)/.exec(text);
  if (!match) throw new Error(`Unexpected ${name} version output.`);
  return { text: text.trim(), major: Number(match[1]) };
}

/** pg_dump must be at least the server's major version (it refuses newer servers, and older dumps lose detail). */
export async function assertToolsMatch(serverMajor: number): Promise<string> {
  const dump = await toolVersion("pg_dump");
  const restore = await toolVersion("pg_restore");
  if (dump.major < serverMajor || restore.major < serverMajor) {
    throw new Error(`pg_dump ${dump.major} / pg_restore ${restore.major} are older than the PostgreSQL ${serverMajor} server. Set PG_BIN to a matching version.`);
  }
  return dump.text;
}

/** pg_dump's custom-format archive of `conn`'s database, as a stream; `done` rejects if pg_dump fails. */
export function dumpDatabase(conn: Connection): { archive: AsyncIterable<Uint8Array>; done: Promise<string>; stop: () => void } {
  const args = ["--format=custom", "--compress=6", ...connectionArgs(conn), "--dbname", conn.database, ...EXCLUDED_TABLE_DATA.flatMap((t) => [`--exclude-table-data=public.${t}`])];
  const { child, stdout, done } = run("pg_dump", args, conn);
  return { archive: stdout, done, stop: () => void child.kill() };
}

/** Decrypts and lists the archive with pg_restore --list (no database is touched). Returns the TOC lines. */
export async function verifyBackupFile(file: string, passphrase: string): Promise<{ header: BackupHeader; entries: string[]; bytes: number }> {
  const { header, plaintext } = await openBackup(createReadStream(file), passphrase);
  let bytes = 0;
  const counted = (async function* () {
    for await (const c of plaintext) {
      bytes += c.length;
      yield c;
    }
  })();
  const { stdout, done } = run("pg_restore", ["--list"], { host: "", port: 0, database: "", user: "" }, counted);
  let list = "";
  for await (const d of stdout) list += d.toString();
  await done;
  return { header, entries: list.split(/\r?\n/).filter((l) => l && !l.startsWith(";")), bytes };
}

/**
 * Restores a backup into `conn`'s database, which the caller has proven to be the approved, empty target. The
 * whole file is authenticated first (a separate pass), then restored in one transaction with --exit-on-error,
 * so a failure leaves nothing restored. Owners and privileges are not restored (the target role owns all).
 */
export async function restoreBackupFile(file: string, passphrase: string, conn: Connection): Promise<void> {
  const { plaintext: check } = await openBackup(createReadStream(file), passphrase);
  for await (const chunk of check) void chunk;
  const { plaintext } = await openBackup(createReadStream(file), passphrase);
  const args = [...connectionArgs(conn), "--dbname", conn.database, "--no-owner", "--no-privileges", "--exit-on-error", "--single-transaction"];
  const { done } = run("pg_restore", args, conn, plaintext);
  await done;
}

/**
 * Writes an encrypted backup of the connection's database to `file`, which must not exist yet. The data goes to
 * "<file>.partial" (created exclusively, owner-only permissions where the platform supports them), is flushed
 * to disk, and is renamed only after pg_dump succeeded; on any failure the partial file is removed.
 */
export async function createBackupFile(conn: Connection, passphrase: string, file: string, meta: { pgDumpVersion: string }): Promise<{ bytes: number }> {
  checkPassphrase(passphrase);
  if (await stat(file).then(() => true, () => false)) throw new Error("The backup file already exists. Nothing was overwritten.");
  const partial = `${file}.partial`;
  const handle = await open(partial, "wx", 0o600);
  let bytes = 0;
  try {
    try {
      const { archive, done, stop } = dumpDatabase(conn);
      try {
        for await (const chunk of encryptStream(archive, passphrase, { createdAt: new Date().toISOString(), database: conn.database, pgDumpVersion: meta.pgDumpVersion })) {
          await handle.write(chunk);
          bytes += chunk.length;
        }
      } catch (error) {
        stop();
        throw error;
      }
      await done;
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(partial, file);
    return { bytes };
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

/**
 * The directory a backup is written to: absolute, existing, and outside the repository (so a backup can never be
 * committed or served). Compared on real paths, case-insensitively on Windows.
 */
export async function backupDirectory(dir: string | undefined, repositoryRoot: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  const path = await import("node:path");
  if (!dir || !path.isAbsolute(dir)) throw new Error("Give the backup directory as an absolute path outside the project, for example --out D:/Backups/babysunray.");
  let real: string;
  try {
    real = await realpath(dir);
  } catch {
    throw new Error("The backup directory does not exist. Create it first.");
  }
  if (!(await stat(real)).isDirectory()) throw new Error("The backup location is not a directory.");
  const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const relative = path.relative(fold(await realpath(repositoryRoot)), fold(real));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("The backup directory is inside the project. Choose a directory outside it, so a backup can never be committed.");
  }
  return real;
}
