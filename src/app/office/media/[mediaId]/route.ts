import { getDb } from "@/db/client";
import { assertPermission, getPrincipal } from "@/modules/auth/principal";
import { getAuth } from "@/modules/auth/server";
import { DomainError } from "@/modules/domain-error";
import { cachedRendition, formatOf, RENDITION_WIDTHS } from "@/modules/media/images";
import { getPhoto } from "@/modules/media/service";
import { getMediaStore } from "@/modules/media/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /office/media/{mediaId}[?w=320|640|1280]: a product photo, for the signed-in Owner only (draft products
// are not public). The stored file is metadata-free; `w` serves a smaller copy. The browser may keep it but
// must check again each time (private, no-cache, ETag), so no shared cache serves it and a signed-out browser
// gets nothing new. It is sent as an image with a sandbox policy and no sniffing, never as a page.

const HEADERS = {
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
  "content-security-policy": "default-src 'none'; sandbox",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
};
const status = (code: number) => new Response(null, { status: code, headers: { ...HEADERS, "cache-control": "no-store" } });

export async function GET(request: Request, { params }: { params: Promise<{ mediaId: string }> }): Promise<Response> {
  try {
    const principal = await getPrincipal(getAuth(), getDb(), request.headers);
    if (!principal) return status(401);
    assertPermission(principal, "catalog:read");
    const photo = await getPhoto(getDb(), (await params).mediaId);
    const requested = Number(new URL(request.url).searchParams.get("w"));
    const width = (RENDITION_WIDTHS as readonly number[]).includes(requested) && requested < photo.width ? requested : null;
    const etag = `"${photo.sha256.slice(0, 32)}-${width ?? "full"}"`;
    const headers = { ...HEADERS, "cache-control": "private, no-cache", etag, "content-type": photo.contentType, "content-disposition": "inline" };
    if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
    const store = getMediaStore();
    const body = width ? await cachedRendition(photo.sha256, width, formatOf(photo.contentType)!, () => store.read(photo.storageKey)) : await store.read(photo.storageKey);
    if (!body) {
      console.error(JSON.stringify({ level: "error", event: "photo_file_missing", mediaId: photo.id }));
      return status(404);
    }
    return new Response(new Uint8Array(body), { status: 200, headers });
  } catch (error) {
    if (error instanceof DomainError && error.code === "FORBIDDEN") return status(403);
    if (error instanceof DomainError && error.code === "MEDIA_NOT_FOUND") return status(404);
    if (error instanceof DomainError && error.code === "MEDIA_STORAGE_UNAVAILABLE") return status(503);
    console.error(JSON.stringify({ level: "error", event: "photo_serve_failed", errorName: error instanceof Error ? error.name : typeof error }));
    return status(500);
  }
}
