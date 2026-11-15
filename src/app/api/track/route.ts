import * as z from "zod";
import { tokenField, trackingRequest } from "@/api/track";
import { viewOf } from "@/modules/orders/tracking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/track {"token": "..."}: the minimal, masked view of the one order the token belongs to.
export async function POST(request: Request): Promise<Response> {
  return trackingRequest(request, z.strictObject({ token: tokenField }), (db, orderId) => viewOf(db, orderId));
}
