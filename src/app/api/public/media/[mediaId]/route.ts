import { publicMediaResponse } from "@/api/public-media";
import { getDb } from "@/db/client";
import { publicShopGate } from "@/modules/launch/gate";
import { getMediaStore } from "@/modules/media/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/public/media/{mediaId}[?w=320]: a photo of a PUBLISHED product. Routed, but CLOSED: the launch gate refuses in
// this version, and it is answered (503, no body) before the database or storage is touched. The database and the store
// are passed as functions for that reason. Gate H.49; src/api/public-media.ts has the rules.
async function handle(request: Request, context: { params: Promise<{ mediaId: string }> }): Promise<Response> {
  const { mediaId } = await context.params;
  return publicMediaResponse(request, mediaId, { db: getDb, store: getMediaStore, gate: publicShopGate });
}
export { handle as GET, handle as HEAD, handle as POST, handle as PUT, handle as DELETE, handle as PATCH };
