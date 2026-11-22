import * as z from "zod";
import { tokenField, trackingRequest } from "@/api/track";
import { anonymousDatabaseWork } from "@/modules/rate-limit/bulkhead";
import { referenceFor } from "@/modules/orders/tracking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/track/payment {"token", "reference"}: the customer's transfer reference for a manual advance payment
// (ADR-0013). Only the reference is accepted: the method and the amount come from the order, never from the request. It
// marks nothing as paid; the shop verifies the money in its own account.
const body = z.strictObject({ token: tokenField, reference: z.string().max(60) });

export async function POST(request: Request): Promise<Response> {
  return trackingRequest(
    request,
    body,
    (db, orderId, b) => referenceFor(db, orderId, b.reference),
    anonymousDatabaseWork,
    "A payment reference cannot be sent for this order now. Please contact the shop.",
  );
}
