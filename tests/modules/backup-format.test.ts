import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkPassphrase, encryptStream, MAGIC, openBackup } from "../../src/db/backup.mts";

// The encrypted backup container (src/db/backup.mts): a round trip returns the exact bytes, and any change to
// the file, a wrong passphrase or a cut-short file is refused before tampered plaintext is released.

const PASSPHRASE = "fictional test passphrase";
const META = { createdAt: "2026-11-15T08:00:00.000Z", database: "babysunray_test", pgDumpVersion: "pg_dump (PostgreSQL) 18.0" };

async function* from(...parts: Buffer[]): AsyncGenerator<Buffer> {
  for (const p of parts) yield p;
}

async function bytes(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const c of stream) out.push(Buffer.from(c));
  return Buffer.concat(out);
}

const encrypt = (plain: Buffer, passphrase = PASSPHRASE) => bytes(encryptStream(from(plain.subarray(0, 1000), plain.subarray(1000)), passphrase, META));
const decrypt = async (file: Buffer, passphrase = PASSPHRASE) => {
  const { header, plaintext } = await openBackup(from(file), passphrase);
  return { header, plain: await bytes(plaintext) };
};

// Plaintext of three full records and a partial fourth (records are 64 KiB).
const PLAIN = randomBytes(3 * 65536 + 12345);

describe("encrypted backup format", () => {
  it("round-trips exactly, with a readable header and no plaintext in the file", async () => {
    const file = await encrypt(PLAIN);
    expect(file.subarray(0, 8)).toEqual(MAGIC);
    const { header, plain } = await decrypt(file);
    expect(plain.equals(PLAIN)).toBe(true);
    expect(header).toMatchObject({ format: "babysunray-backup", version: 1, cipher: "AES-256-GCM", database: "babysunray_test" });
    expect(file.includes(PLAIN.subarray(5000, 5064))).toBe(false);
  }, 30_000);

  it("round-trips an empty archive and an exact multiple of the record size", async () => {
    expect((await decrypt(await encrypt(Buffer.alloc(0)))).plain.length).toBe(0);
    const exact = randomBytes(2 * 65536);
    expect((await decrypt(await encrypt(exact))).plain.equals(exact)).toBe(true);
  }, 30_000);

  it("refuses a wrong passphrase", async () => {
    const file = await encrypt(PLAIN);
    await expect(decrypt(file, "another fictional passphrase")).rejects.toThrow(/damaged|passphrase/);
  }, 30_000);

  it("refuses any changed byte in a record, the header, or the record order", async () => {
    const file = await encrypt(PLAIN);
    const flipped = Buffer.from(file);
    flipped[file.length - 30_000] ^= 0x01;
    await expect(decrypt(flipped)).rejects.toThrow();

    const headerLength = file.readUInt32BE(8);
    const header = Buffer.from(file);
    const at = 12 + header.subarray(12, 12 + headerLength).indexOf("babysunray_test");
    header[at] = "c".charCodeAt(0); // database name edited
    await expect(decrypt(header)).rejects.toThrow();

    // Swap the first two records (same size): every record is bound to its position.
    const start = 12 + headerLength;
    const recordSize = 5 + 65536 + 16;
    const swapped = Buffer.concat([file.subarray(0, start), file.subarray(start + recordSize, start + 2 * recordSize), file.subarray(start, start + recordSize), file.subarray(start + 2 * recordSize)]);
    await expect(decrypt(swapped)).rejects.toThrow();
  }, 60_000);

  it("refuses a file cut short, even at a record boundary, and extra data after the end", async () => {
    const file = await encrypt(PLAIN);
    const start = 12 + file.readUInt32BE(8);
    const recordSize = 5 + 65536 + 16;
    await expect(decrypt(file.subarray(0, file.length - 10))).rejects.toThrow();
    await expect(decrypt(file.subarray(0, start + 2 * recordSize))).rejects.toThrow();
    await expect(decrypt(Buffer.concat([file, Buffer.from([0])]))).rejects.toThrow();
  }, 60_000);

  it("does not release a tampered record's plaintext", async () => {
    const file = await encrypt(PLAIN);
    const tampered = Buffer.from(file);
    tampered[12 + file.readUInt32BE(8) + 10] ^= 0xff; // inside the first record
    const { plaintext } = await openBackup(from(tampered), PASSPHRASE);
    const released: Buffer[] = [];
    await expect(
      (async () => {
        for await (const c of plaintext) released.push(c);
      })(),
    ).rejects.toThrow();
    expect(released).toHaveLength(0);
  }, 30_000);

  it("refuses short passphrases and unknown files", async () => {
    expect(() => checkPassphrase("too short")).toThrow(/at least 12/);
    await expect(openBackup(from(Buffer.from("PGDMP-plain-dump")), PASSPHRASE)).rejects.toThrow("not a backup file");
  });
});
