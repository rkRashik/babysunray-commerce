import { publicMediaResponse } from "@/api/public-media";
import { accessForRequest } from "@/app/_shop/access";
import { getDb } from "@/db/client";
import { getMediaStore } from "@/modules/media/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/public/media/{mediaId}[?w=320]: a photo of a PUBLISHED product, for the shop (ADR-0011). Answered only while the
// shop is open for this request: the public launch gate (closed in this version) or a founder acceptance pass on the staging
// database. Closed: 503 with no body, before the database or storage is touched (no pass, no query). src/api/public-media.ts
// has the rules; a published photo with a Cloudinary copy is delivered from the CDN instead.
async function handle(request: Request, context: { params: Promise<{ mediaId: string }> }): Promise<Response> {
  const { mediaId } = await context.params;
  const open = request.method === "GET" && (await accessForRequest(request)) !== "closed";
  return publicMediaResponse(request, mediaId, { db: getDb, store: getMediaStore, gate: () => ({ open }) });
}
export { handle as GET, handle as HEAD, handle as POST, handle as PUT, handle as DELETE, handle as PATCH };
