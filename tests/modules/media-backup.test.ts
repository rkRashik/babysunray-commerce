import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sealStream } from "../../src/db/backup.mts";
import { MEDIA_BACKUP_FORMAT, readMediaBackup } from "../../src/modules/media/backup";

// The photo backup format against hostile content that is correctly encrypted (so only the manifest checks can stop
// it): malformed manifests, unsupported versions, path names, duplicates, wrong hashes, extra data. Fictional bytes.

const PASS = "fictional unit-test phrase";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const photo = Buffer.from("fictional photo bytes");
const entry = (over: Record<string, unknown> = {}) => ({
  mediaId: randomUUID(),
  productId: randomUUID(),
  productSlug: "fictional-romper",
  position: 0,
  storageKey: `${"a".repeat(32)}.png`,
  contentType: "image/png",
  byteSize: photo.length,
  width: 400,
  height: 300,
  sha256: sha(photo),
  altEn: null,
  altBn: null,
  createdAt: "2026-11-16T00:00:00.000Z",
  updatedAt: "2026-11-16T00:00:00.000Z",
  ...over,
});

async function seal(manifest: unknown, files: Buffer[], header: Record<string, unknown> = {}, tail = Buffer.alloc(0)): Promise<Buffer> {
  const bytes = Buffer.from(JSON.stringify(manifest));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  const list = (manifest as { files?: { byteSize?: number }[] }).files ?? [];
  const describe = {
    format: MEDIA_BACKUP_FORMAT,
    version: 1,
    createdAt: "2026-11-16T00:00:00.000Z",
    database: "fictional",
    files: list.length,
    bytes: list.reduce((n, f) => n + (f.byteSize ?? 0), 0),
    manifestSha256: sha(bytes),
    ...header,
  };
  async function* plain() {
    yield Buffer.concat([Buffer.from("BSMEDIA1"), length, bytes, ...files, tail]);
  }
  const out: Buffer[] = [];
  for await (const c of sealStream(plain(), PASS, describe)) out.push(c);
  return Buffer.concat(out);
}

const read = (file: Buffer, pass = PASS) => readMediaBackup((async function* () { yield file; })(), pass);
const manifest = (files: unknown[], over: Record<string, unknown> = {}) => ({ format: "babysunray-media-manifest", version: 1, createdAt: "2026-11-16T00:00:00.000Z", database: "fictional", files, ...over });

// Each case runs the deliberately slow scrypt key derivation twice (seal and open).
describe("photo backup format", { timeout: 60_000 }, () => {
  it("reads a correct backup and hands over each verified file", async () => {
    const got: string[] = [];
    const { header } = await readMediaBackup((async function* () { yield await seal(manifest([entry()]), [photo]); })(), PASS, async (f, data) => {
      got.push(`${f.storageKey}:${data.toString()}`);
    });
    expect([header.files, got]).toEqual([1, [`${"a".repeat(32)}.png:fictional photo bytes`]]);
  });

  it("refuses wrong passphrases, malformed manifests, unsupported versions and unexpected path names", async () => {
    await expect(read(await seal(manifest([entry()]), [photo]), "another fictional phrase")).rejects.toThrow(/damaged|passphrase/);
    const cases: [string, unknown][] = [
      ["version 2", manifest([entry()], { version: 2 })],
      ["extra field", manifest([entry({ path: "C:/Windows/x.png" })])],
      ["parent path", manifest([entry({ storageKey: "../escape.png" })])],
      ["windows path", manifest([entry({ storageKey: "..\\escape.png" })])],
      ["absolute path", manifest([entry({ storageKey: "/etc/passwd" })])],
      ["svg", manifest([entry({ storageKey: `${"a".repeat(32)}.svg`, contentType: "image/svg+xml" })])],
      ["not a manifest", { hello: "world" }],
    ];
    for (const [name, m] of cases) await expect(read(await seal(m, [photo])), name).rejects.toThrow(/malformed|unsupported/);
  });

  it("refuses duplicate keys, a wrong hash, a header that does not match, a short file and data after the end", async () => {
    const one = entry();
    await expect(read(await seal(manifest([one, { ...one, mediaId: randomUUID() }]), [photo, photo]))).rejects.toThrow(/same file twice/);
    await expect(read(await seal(manifest([entry({ sha256: sha(Buffer.from("other")) })]), [photo]))).rejects.toThrow(/SHA-256/);
    await expect(read(await seal(manifest([entry()]), [photo], { files: 2 }))).rejects.toThrow(/header does not match/);
    await expect(read(await seal(manifest([entry()]), [photo.subarray(0, 5)]))).rejects.toThrow(/cut short/);
    await expect(read(await seal(manifest([entry()]), [photo], {}, Buffer.from("x")))).rejects.toThrow(/after its last photo/);
  });

  it("is not readable as a database backup, and a database backup is not readable as a photo backup", async () => {
    const { openBackup } = await import("../../src/db/backup.mts");
    const file = await seal(manifest([entry()]), [photo]);
    await expect(openBackup((async function* () { yield file; })(), PASS)).rejects.toThrow(/not a database backup/);
    const db: Buffer[] = [];
    for await (const c of sealStream((async function* () { yield Buffer.from("x"); })(), PASS, { format: "babysunray-backup", version: 1 })) db.push(c);
    await expect(read(Buffer.concat(db))).rejects.toThrow(/not a photo backup/);
  });
});
