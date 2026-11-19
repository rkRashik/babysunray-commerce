import "server-only";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { type InstallationIdentity, readInstallationIdentity } from "@/config/installation";
import { type Db, pgErrorCode } from "@/db/database";
import { storeSettings } from "@/db/schema";
import { actorFor, assertPermission, type Principal } from "../auth/principal";
import { READINESS_ITEMS, type PreparationItem } from "../catalogue/readiness";
import { DomainError, invalidInput } from "../domain-error";
import { type Once, runOnce } from "../idempotency/service";
import { uploadDigest } from "../media/images";

// The store's settings, edited by the Owner in Admin (ADR-0012): identity, contact channels, logo, and the approved
// publication rule. One row (store_settings, id 1). Every empty field falls back to the installation's STORE_* defaults
// (src/config/installation.ts), so there is one source per value: the Owner's setting when given, else the default. On a
// database without migration 0021 the defaults are used and the Admin page says the update is needed.

export type StoreSettings = typeof storeSettings.$inferSelect;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const LOGO_MAX_SIDE = 1200;

async function row(db: Db): Promise<StoreSettings | null> {
  try {
    const [r] = await db.select().from(storeSettings).where(eq(storeSettings.id, 1));
    return r ?? null;
  } catch (error) {
    if (pgErrorCode(error) === "42P01") return null;
    throw error;
  }
}

/** The identity customers and Admin see now: the Owner's settings over the installation defaults. */
export async function storeIdentity(db: Db, env: Record<string, string | undefined> = process.env): Promise<InstallationIdentity> {
  const base = readInstallationIdentity(env).identity;
  const r = await row(db);
  if (!r) return base;
  return {
    storeName: r.storeName ?? base.storeName,
    storeLine: { en: r.lineEn ?? base.storeLine.en, bn: r.lineBn ?? base.storeLine.bn },
    contact: { phone: r.contactPhone ?? base.contact.phone, email: r.contactEmail ?? base.contact.email, whatsapp: r.contactWhatsapp, messenger: r.contactMessenger },
    theme: base.theme,
    logo: r.logoSha256 && r.logoWidth && r.logoHeight ? { src: `/brand/logo?v=${r.logoSha256.slice(0, 12)}`, width: r.logoWidth, height: r.logoHeight } : null,
  };
}

/** The uploaded logo's bytes and type, or null. */
export async function storeLogo(db: Db): Promise<{ data: Buffer; contentType: string } | null> {
  const r = await row(db);
  return r?.logoBase64 && r.logoContentType ? { data: Buffer.from(r.logoBase64, "base64"), contentType: r.logoContentType } : null;
}

/** The settings row for the Admin form (null before the first save; `schemaReady` false without migration 0021). */
export async function storeSettingsForAdmin(db: Db, principal: Principal): Promise<{ settings: StoreSettings | null; schemaReady: boolean }> {
  assertPermission(principal, "settings:write");
  const { rows } = await db.execute<{ ready: boolean }>(sql`select to_regclass('public.store_settings') is not null as ready`);
  return { settings: rows[0].ready ? await row(db) : null, schemaReady: rows[0].ready };
}

function field(raw: unknown, name: string, max: number, pattern?: { test: RegExp; rule: string }): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") throw invalidInput(name, "must be text");
  const value = raw.normalize("NFC").trim();
  if (value === "") return null;
  if (value.length > max || CONTROL.test(value)) throw invalidInput(name, `must be at most ${max} characters on one line`);
  if (pattern && !pattern.test.test(value)) throw invalidInput(name, pattern.rule);
  return value;
}

const PHONE = { test: /^\+?[0-9][0-9 -]{5,20}$/, rule: "must be a phone number (digits, spaces, hyphens, an optional leading +)" };

export type IdentityInput = { storeName: unknown; lineEn: unknown; lineBn: unknown; contactPhone: unknown; contactEmail: unknown; contactWhatsapp: unknown; contactMessenger: unknown };

/** Saves the identity and contact fields at `expectedVersion` (0 before the first save). Empty means "use the default". */
export async function updateStoreIdentity(tx: Db, input: IdentityInput & { expectedVersion: number }, userId: string): Promise<{ version: number }> {
  const values = {
    storeName: field(input.storeName, "storeName", 60),
    lineEn: field(input.lineEn, "lineEn", 200),
    lineBn: field(input.lineBn, "lineBn", 200),
    contactPhone: field(input.contactPhone, "contactPhone", 30, PHONE),
    contactEmail: field(input.contactEmail, "contactEmail", 120, { test: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, rule: "must be an email address" }),
    contactWhatsapp: field(input.contactWhatsapp, "contactWhatsapp", 30, PHONE),
    contactMessenger: field(input.contactMessenger, "contactMessenger", 200, { test: /^https:\/\/(m\.me|(www\.)?(facebook|messenger)\.com)\/[^\s]+$/, rule: "must be an https://m.me/… or facebook.com link" }),
  };
  return save(tx, input.expectedVersion, values, userId);
}

async function save(tx: Db, expectedVersion: number, values: Partial<StoreSettings>, userId: string): Promise<{ version: number }> {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw invalidInput("version", "must be a whole number");
  if (expectedVersion === 0) {
    const [inserted] = await tx.insert(storeSettings).values({ id: 1, ...values, updatedByUserId: userId }).onConflictDoNothing().returning({ version: storeSettings.version });
    if (!inserted) throw stale();
    return inserted;
  }
  const [updated] = await tx
    .update(storeSettings)
    .set({ ...values, version: sql`${storeSettings.version} + 1`, updatedAt: sql`now()`, updatedByUserId: userId })
    .where(sql`${storeSettings.id} = 1 and ${storeSettings.version} = ${expectedVersion}`)
    .returning({ version: storeSettings.version });
  if (!updated) throw stale();
  return updated;
}
const stale = () => new DomainError("VERSION_CONFLICT", "The settings changed after you opened them. Reload and try again.");

const loadVersion = async (db: Db) => ({ version: (await row(db))?.version ?? 0 });

export function updateStoreIdentityOnce(db: Db, principal: Principal, key: string, input: IdentityInput & { expectedVersion: number }): Promise<Once<{ version: number }>> {
  const user = assertPermission(principal, "settings:write");
  const request = { ...input } as Record<string, unknown>;
  for (const k of Object.keys(request)) if (request[k] === undefined) request[k] = null;
  return runOnce(db, { userId: user.userId, operation: "settings.store.identity", key, request }, (tx) => updateStoreIdentity(tx, input, actorFor(user).ref), loadVersion);
}

/** Re-encodes an uploaded logo (PNG kept for transparency, otherwise WebP), at most 1200 px, metadata removed, and saves it. */
export async function uploadStoreLogoOnce(db: Db, principal: Principal, key: string, input: { expectedVersion: number; bytes: Buffer }): Promise<Once<{ version: number }>> {
  const user = assertPermission(principal, "settings:write");
  if (input.bytes.length === 0 || input.bytes.length > 5 * 1024 * 1024) throw invalidInput("logo", "must be an image file of at most 5 MB");
  let image: { data: Buffer; info: { format: string; width: number; height: number } };
  try {
    const source = sharp(input.bytes, { limitInputPixels: 40_000_000 }).rotate().resize({ width: LOGO_MAX_SIDE, height: LOGO_MAX_SIDE, fit: "inside", withoutEnlargement: true });
    const meta = await sharp(input.bytes).metadata();
    image = meta.hasAlpha || meta.format === "png" ? await source.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true }) : await source.webp({ quality: 88 }).toBuffer({ resolveWithObject: true });
  } catch {
    throw invalidInput("logo", "is not a readable image (PNG, JPEG or WebP)");
  }
  if (image.data.length > 500_000) throw invalidInput("logo", "is too large after optimisation; use a simpler or smaller image");
  const contentType = image.info.format === "png" ? "image/png" : "image/webp";
  const values = { logoBase64: image.data.toString("base64"), logoContentType: contentType, logoWidth: image.info.width, logoHeight: image.info.height, logoSha256: uploadDigest(image.data) };
  const request = { expectedVersion: input.expectedVersion, upload: uploadDigest(input.bytes) };
  return runOnce(db, { userId: user.userId, operation: "settings.store.logo", key, request }, (tx) => save(tx, input.expectedVersion, values, actorFor(user).ref), loadVersion);
}

export function removeStoreLogoOnce(db: Db, principal: Principal, key: string, input: { expectedVersion: number }): Promise<Once<{ version: number }>> {
  const user = assertPermission(principal, "settings:write");
  const values = { logoBase64: null, logoContentType: null, logoWidth: null, logoHeight: null, logoSha256: null };
  return runOnce(db, { userId: user.userId, operation: "settings.store.logo.remove", key, request: input }, (tx) => save(tx, input.expectedVersion, values, actorFor(user).ref), loadVersion);
}

// --- The publication rule (I-6) --------------------------------------------------------------------------------------

const FOUNDER_STATED = READINESS_ITEMS.filter((i) => i.basis === "approved").map((i) => i.id) as PreparationItem[];

/** The Owner-approved publication rule, or null when none is approved. Its id names the approval time. */
export async function approvedPublicationRuleFromSettings(db: Db): Promise<{ id: string; items: readonly PreparationItem[] } | null> {
  const r = await row(db);
  if (!r?.publicationRuleApprovedAt || !Array.isArray(r.publicationRuleItems)) return null;
  const items = (r.publicationRuleItems as unknown[]).filter((i): i is PreparationItem => READINESS_ITEMS.some((x) => x.id === i));
  return { id: `owner-approved-${r.publicationRuleApprovedAt.toISOString().slice(0, 10)}`, items };
}

/**
 * Approves which readiness items every product must meet before it can be published (requirement I-6). The founder-stated
 * items are always included. Approval is the Owner's own decision, recorded with who and when; it replaces any earlier one.
 */
export function approvePublicationRuleOnce(db: Db, principal: Principal, key: string, input: { expectedVersion: number; items: unknown; approved: boolean }): Promise<Once<{ version: number }>> {
  const user = assertPermission(principal, "catalog:publish");
  if (input.approved !== true) throw invalidInput("approval", "is required: tick that you approve these requirements");
  if (!Array.isArray(input.items) || input.items.some((i) => !READINESS_ITEMS.some((x) => x.id === i))) throw invalidInput("items", "must be readiness checklist items");
  const items = [...new Set([...FOUNDER_STATED, ...(input.items as PreparationItem[])])];
  const request = { expectedVersion: input.expectedVersion, items: [...items].sort() };
  return runOnce(
    db,
    { userId: user.userId, operation: "settings.publication.approve", key, request },
    (tx) => save(tx, input.expectedVersion, { publicationRuleItems: request.items, publicationRuleApprovedAt: new Date(), publicationRuleApprovedByUserId: user.userId }, actorFor(user).ref),
    loadVersion,
  );
}
