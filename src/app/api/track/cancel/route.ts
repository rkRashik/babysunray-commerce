import * as z from "zod";
import { tokenField, trackingRequest } from "@/api/track";
import { cancelFor } from "@/modules/orders/tracking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/track/cancel {"token", "action": "cancel" | "request", "reason"?}: the customer cancels a Pending
// Verification order, or asks to cancel a confirmed one that has not been dispatched (founder rule C).
const body = z.strictObject({ token: tokenField, action: z.enum(["cancel", "request"]), reason: z.string().max(500).nullable().optional() });

export async function POST(request: Request): Promise<Response> {
  return trackingRequest(request, body, (db, orderId, b) => cancelFor(db, orderId, b.action, b.reason ?? null));
}
