import "server-only";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

// The order-list name or phone search. A customer's name or phone number never goes into a URL, so it travels in this
// cookie: HttpOnly (page scripts cannot read it), SameSite=Strict, Secure in production and limited to /admin/orders. The value
// is sealed (AES-256-GCM, key derived from the installation's auth secret) and bound to the signed-in user, so it cannot be
// read from the browser's cookie store, altered, or reused by another user of the same browser; it carries its own expiry
// and is also expired by the browser. "Clear search" and an empty search delete it.

export const SEARCH_COOKIE = "bsr_order_search";
export const SEARCH_TTL_SECONDS = 15 * 60;

const key = (secret: string) => Buffer.from(hkdfSync("sha256", secret, "bsr-admin", "order-search-cookie-v1", 32));

export function sealSearch(term: string, userId: string, secret: string, now = Date.now()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  cipher.setAAD(Buffer.from(userId));
  const body = Buffer.concat([cipher.update(JSON.stringify({ t: term, e: now + SEARCH_TTL_SECONDS * 1000 }), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

/** The term, or null for anything missing, altered, expired or sealed for another user. */
export function openSearch(value: string | undefined, userId: string, secret: string, now = Date.now()): string | null {
  if (!value || value.length > 1024) return null;
  try {
    const raw = Buffer.from(value, "base64url");
    if (raw.length < 12 + 16 + 2) return null;
    const decipher = createDecipheriv("aes-256-gcm", key(secret), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(userId));
    decipher.setAuthTag(raw.subarray(12, 28));
    const parsed = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")) as { t?: unknown; e?: unknown };
    return typeof parsed.t === "string" && typeof parsed.e === "number" && parsed.e > now ? parsed.t : null;
  } catch {
    return null;
  }
}
