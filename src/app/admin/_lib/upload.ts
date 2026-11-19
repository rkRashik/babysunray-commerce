import "server-only";
import { getDb } from "@/db/client";
import type { Permission } from "@/modules/auth/permissions";
import { assertPermission, getPrincipal, type Principal } from "@/modules/auth/principal";
import { getAuth } from "@/modules/auth/server";

// Shared checks for Admin's file-upload route handlers (photos, catalogue import): a POST from this site's own
// origin only (CSRF), the session cookie only, the permission, and a body read with a byte limit so an oversized
// upload never fills memory. Server Actions are not used for files because their body limit is global.

export const PRIVATE_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" };

/** Reads at most `limit` bytes of the body; null if it is longer. */
export async function readLimited(request: Request, limit: number): Promise<Buffer | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared > limit) return null;
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return Buffer.concat(chunks);
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
}

/** The multipart form of a body already read within its limit, or null if it is not a valid form. */
export async function formOf(request: Request, body: Buffer): Promise<FormData | null> {
  try {
    return await new Request(request.url, { method: "POST", headers: { "content-type": request.headers.get("content-type") ?? "" }, body: new Uint8Array(body) }).formData();
  } catch {
    return null;
  }
}

export type UploadCheck = { ok: true; principal: Principal } | { ok: false; reason: "origin" | "signed_out" | "forbidden" };

/** Origin, session and permission, in that order. */
export async function checkUpload(request: Request, permission: Permission): Promise<UploadCheck> {
  if (request.headers.get("origin") !== getAuth().options.baseURL) return { ok: false, reason: "origin" };
  const principal = await getPrincipal(getAuth(), getDb(), request.headers);
  if (!principal) return { ok: false, reason: "signed_out" };
  try {
    assertPermission(principal, permission);
  } catch {
    return { ok: false, reason: "forbidden" };
  }
  return { ok: true, principal };
}
