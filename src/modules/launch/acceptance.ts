import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@/db/database";
import { findActiveRole } from "../auth/access";
import { publicShopGate } from "./gate";

// Founder acceptance (ADR-0011): who may use the real shop before the public launch. Three answers, decided per request
// on the server:
//
//   public      the launch gate is open (gate.ts). In this version it never is: opening it is a founder-approved code change.
//   acceptance  this browser holds a valid ACCEPTANCE PASS (a signed, HttpOnly cookie the signed-in Owner starts in the
//               Admin), the pass's Owner still has active access, and the connected database carries the STAGING marker
//               (schema babysunray_target with the comment 'babysunray:staging', set by the founder in the staging project).
//   closed      anything else. Answered before any database work: without a pass that verifies, no query runs.
//
// So the real catalogue, checkout and order services run for the founder only, against staging only. A production database
// is not marked staging (staging-setup.md), so no pass, setting or route can open acceptance there: after the switch to
// production, the shop answers only when the launch gate itself opens. There is no query parameter, header, environment
// variable or setting that changes any of this. Netlify's visitor protection stays a separate, outer wall.

export type ShopAccess = "public" | "acceptance" | "closed";

export const ACCEPTANCE_COOKIE = "bsr_acceptance";
/** How long a pass lasts. A new one can be started from Admin at any time. */
export const PASS_HOURS = 8;
const PASS_VERSION = "v1";
const TARGET_SCHEMA = "babysunray_target";
export const STAGING_MARKER = "babysunray:staging";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

// A key of its own, derived from the installation secret, so a pass can never stand in for a session cookie or the reverse.
const passKey = (secret: string) => createHmac("sha256", secret).update("babysunray:acceptance-pass:v1").digest();
const mac = (secret: string, payload: string) => createHmac("sha256", passKey(secret)).update(payload).digest("base64url");

/** A pass for `userId` (an Owner, checked by the caller), valid for PASS_HOURS from `now`. */
export function issuePass(secret: string, userId: string, now = Date.now()): { value: string; expiresAt: Date } {
  if (!UUID.test(userId)) throw new Error("issuePass needs a user id.");
  const expires = Math.floor(now / 1000) + PASS_HOURS * 3600;
  const payload = `${PASS_VERSION}.${userId}.${expires}.${randomBytes(16).toString("base64url")}`;
  return { value: `${payload}.${mac(secret, payload)}`, expiresAt: new Date(expires * 1000) };
}

/** The pass's Owner, or null for a missing, malformed, forged or expired pass. No database work. */
export function verifyPass(secret: string, value: string | undefined | null, now = Date.now()): { userId: string } | null {
  if (typeof value !== "string" || value.length > 300) return null;
  const parts = value.split(".");
  if (parts.length !== 5) return null;
  const [version, userId, expires, nonce, signature] = parts;
  if (version !== PASS_VERSION || !UUID.test(userId) || !/^[0-9]{10}$/.test(expires) || !B64URL.test(nonce) || !B64URL.test(signature)) return null;
  const expected = Buffer.from(mac(secret, parts.slice(0, 4).join(".")));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const expiresAt = Number(expires) * 1000;
  // Expired, or claiming more than one pass lifetime ahead (a pass this code did not issue).
  if (expiresAt <= now || expiresAt > now + PASS_HOURS * 3_600_000 + 60_000) return null;
  return { userId };
}

const MARKER_CACHE_MS = 60_000;
let markerCache: { at: number; staging: boolean } | null = null;

/** Whether the connected database carries the staging marker. Read from PostgreSQL itself; cached for a minute per process. */
export async function isStagingDatabase(db: Db, now = Date.now()): Promise<boolean> {
  if (markerCache && now - markerCache.at < MARKER_CACHE_MS) return markerCache.staging;
  const { rows } = await db.execute<{ marker: string | null }>(sql`select obj_description(to_regnamespace(${TARGET_SCHEMA})::oid, 'pg_namespace') as marker`);
  const staging = rows[0]?.marker === STAGING_MARKER;
  markerCache = { at: now, staging };
  return staging;
}

/** For tests that add or remove the marker within one process. */
export function forgetStagingMarker(): void {
  markerCache = null;
}

/** What Admin's acceptance page shows: whether acceptance can run here, and what the shop would show now. */
export async function acceptanceFacts(db: Db): Promise<{ staging: boolean; schemaReady: boolean; publishedProducts: number; activeZones: number }> {
  const staging = await isStagingDatabase(db);
  const { rows } = await db.execute<{ products: number; zones: number; ready: boolean }>(sql`select
    (select count(*) from products where status = 'published')::int as products,
    (select count(*) from delivery_zones where active)::int as zones,
    (to_regclass('public.policy_publications') is not null and to_regclass('public.customer_orders') is not null) as ready`);
  return { staging, schemaReady: rows[0].ready, publishedProducts: rows[0].products, activeZones: rows[0].zones };
}

/** The acceptance cookie's value in a Cookie header, or undefined. */
export function passFromCookieHeader(header: string | null): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === ACCEPTANCE_COOKIE) return part.slice(at + 1).trim();
  }
  return undefined;
}

/**
 * Who may use the shop on this request. `pass` is the acceptance cookie's value (or undefined). The public gate is asked
 * first and needs no data; a request without a verifying pass is closed before any database work.
 */
export async function shopAccess(deps: { db: () => Db; secret: () => string }, pass: string | undefined): Promise<ShopAccess> {
  if (publicShopGate().open) return "public";
  if (!pass) return "closed";
  const holder = verifyPass(deps.secret(), pass);
  if (!holder) return "closed";
  const db = deps.db();
  if (!(await isStagingDatabase(db))) return "closed";
  if ((await findActiveRole(db, holder.userId)) !== "owner") return "closed";
  return "acceptance";
}
