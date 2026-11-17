import "server-only";
import { randomUUID } from "node:crypto";
import { type Db, pgErrorCode } from "@/db/database";
import { cachedRendition, formatOf, RENDITION_WIDTHS } from "@/modules/media/images";
import { findPublicPhoto } from "@/modules/media/public";
import type { MediaStore } from "@/modules/media/storage";
import { anonymousDatabaseWork, type Bulkhead } from "@/modules/rate-limit/bulkhead";

// The public photo transport (Gate H.44), routed at /api/public/media/{id} in Gate H.49 but CLOSED: the gate is answered
// before any database or storage work, and the real launch gate (src/modules/launch/gate.ts) refuses in this version.
// Only photos of published products are served (src/modules/media/public.ts); there is no signed or guessable URL, and the
// stored file is never public. `no-store` for now: a caching policy depends on hosting.

export type PublicMediaDeps = { db: () => Db; store: () => MediaStore; gate: () => { open: boolean }; bulkhead?: Bulkhead };

const HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; sandbox",
  "cross-origin-resource-policy": "same-origin",
};
const refuse = (status: number, requestId: string, extra: Record<string, string> = {}) =>
  new Response(null, { status, headers: { ...HEADERS, "x-request-id": requestId, ...extra } });

export async function publicMediaResponse(request: Request, mediaId: string, deps: PublicMediaDeps): Promise<Response> {
  const requestId = randomUUID();
  if (request.method !== "GET") return refuse(405, requestId, { allow: "GET" });
  if (!deps.gate().open) return refuse(503, requestId);
  const params = [...new URL(request.url).searchParams];
  const w = params.length === 1 && params[0][0] === "w" ? Number(params[0][1]) : null;
  if (params.length > 1 || (params.length === 1 && w === null) || (w !== null && !(RENDITION_WIDTHS as readonly number[]).includes(w))) return refuse(400, requestId);
  try {
    const found = await (deps.bulkhead ?? anonymousDatabaseWork)(() => findPublicPhoto(deps.db(), mediaId));
    if (!found.ok) return refuse(503, requestId, { "retry-after": "1" });
    const photo = found.value;
    if (!photo) return refuse(404, requestId);
    const store = deps.store();
    const body = w && w < photo.width ? await cachedRendition(photo.sha256, w, formatOf(photo.contentType)!, () => store.read(photo.storageKey)) : await store.read(photo.storageKey);
    if (!body) {
      console.error(JSON.stringify({ level: "error", event: "public_photo_file_missing", requestId }));
      return refuse(404, requestId);
    }
    return new Response(new Uint8Array(body), { status: 200, headers: { ...HEADERS, "x-request-id": requestId, "content-type": photo.contentType, "content-disposition": "inline" } });
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "public_photo_failed", requestId, errorName: error instanceof Error ? error.name : typeof error, sqlState: pgErrorCode(error) ?? null }));
    return refuse(500, requestId);
  }
}
