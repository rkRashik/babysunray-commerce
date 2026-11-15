import * as z from "zod";
import type { DeliveryZoneRow } from "@/modules/orders/delivery";
import type { Order } from "@/modules/orders/internal";
import type { OrderDetail } from "@/modules/orders/queries";
import { formatOrderNumber } from "@/modules/orders/rules";
import { apiRegistry } from "./schemas";

// Wire formats of the order endpoints (added in 1.3.0). Same rules as schemas.ts: these zod schemas are the
// single source for DTOs, input validation and the OpenAPI document. Money is integer paisa, times UTC.

const timestamp = z.iso.datetime().meta({ description: "UTC, ISO 8601." });
const paisa = (description = "Integer paisa (1 BDT = 100 paisa).") => z.int().min(0).meta({ description });
const version = z.int().min(1).meta({ description: "Changes with every update. Send it back as `version` with the next change." });
const orderStatus = z.enum(["pending_verification", "verification_expired", "confirmed", "cancelled", "closed"]);
const fulfilmentStatus = z.enum(["unfulfilled", "packed", "dispatched", "delivered", "rto", "rto_received"]);
const paymentStatus = z.enum(["unpaid", "partially_collected", "collected", "settled"]).meta({ description: "Derived from the collected and settled amounts." });
const returnStatus = z.enum(["none", "requested", "in_progress", "resolved"]);
const zone = z.enum(["dhaka_city", "outside_dhaka"]);
const source = z.enum(["website", "messenger", "whatsapp", "other"]);
const actor = z.object({
  type: z.enum(["system", "user", "customer"]),
  ref: z.string().meta({ description: "A system label, the user's immutable id, or `tracking-link` for a customer. Never a name or contact detail." }),
});

export const orderSummarySchema = z
  .object({
    id: z.uuid(),
    reference: z.string().meta({ description: "Human reference such as ORD-000042. Not a credential." }),
    source,
    orderStatus,
    fulfilmentStatus,
    paymentStatus,
    returnStatus,
    customer: z.object({ name: z.string(), phone: z.string().meta({ description: "Bangladesh mobile number, 01XXXXXXXXX." }) }),
    deliveryZone: zone,
    totalPaisa: paisa("Expected COD: subtotal plus delivery charge."),
    verificationExpiresAt: timestamp,
    version,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .register(apiRegistry, { id: "OrderSummary" });

export const orderSchema = orderSummarySchema
  .extend({
    deliveryAddress: z.string(),
    note: z.string().nullable(),
    subtotalPaisa: paisa(),
    deliveryChargePaisa: paisa("Snapshotted from the zone's configured charge at submission."),
    codCollectedPaisa: paisa(),
    codSettledPaisa: paisa(),
    refundedPaisa: paisa(),
    rtoChargePaisa: z.int().min(0).nullable(),
    confirmedAt: timestamp.nullable(),
    deliveredAt: timestamp.nullable(),
    closedAt: timestamp.nullable(),
    items: z.array(
      z.object({
        id: z.uuid(),
        variantId: z.uuid(),
        sku: z.string(),
        name: z.object({ en: z.string().nullable(), bn: z.string().nullable() }),
        size: z.string().nullable(),
        colour: z.string().nullable(),
        unitPricePaisa: paisa(),
        quantity: z.int().min(1),
        lineTotalPaisa: paisa(),
      }),
    ),
    reservations: z.array(
      z.object({
        variantId: z.uuid(),
        quantity: z.int().min(1),
        status: z.enum(["active", "released", "consumed"]),
        releaseReason: z.enum(["cancelled", "expired"]).nullable(),
        createdAt: timestamp,
        endedAt: timestamp.nullable(),
      }),
    ),
    cancellationRequests: z.array(z.object({ id: z.uuid(), status: z.enum(["open", "approved", "rejected"]), reason: z.string().nullable(), createdAt: timestamp, reviewedAt: timestamp.nullable() })),
    returns: z.array(
      z.object({
        id: z.uuid(),
        kind: z.enum(["return", "exchange"]),
        reason: z.enum(["size_or_preference", "wrong_or_defective"]),
        shippingPaidBy: z.enum(["customer", "business"]),
        returnShippingCostPaisa: z.int().min(0).nullable(),
        status: z.enum(["requested", "received", "approved", "rejected", "completed"]),
        note: z.string().nullable(),
        items: z.array(z.object({ orderItemId: z.uuid(), quantity: z.int().min(1) })),
        createdAt: timestamp,
      }),
    ),
    quarantine: z.array(
      z.object({
        id: z.uuid(),
        orderItemId: z.uuid(),
        source: z.enum(["rto", "return"]),
        returnId: z.uuid().nullable(),
        quantity: z.int().min(1),
        status: z.enum(["awaiting_inspection", "restocked", "rejected"]),
        note: z.string().nullable(),
        receivedAt: timestamp,
        inspectedAt: timestamp.nullable(),
      }),
    ),
    payments: z.array(
      z.object({
        id: z.int().min(1),
        kind: z.enum(["collected", "settled", "refunded"]),
        amountPaisa: paisa(),
        occurredOn: z.iso.date(),
        method: z.enum(["bkash", "nagad", "bank_transfer"]).nullable(),
        reference: z.string().nullable(),
        returnId: z.uuid().nullable(),
        createdAt: timestamp,
      }),
    ),
    events: z.array(z.object({ id: z.int().min(1), event: z.string(), actor, createdAt: timestamp })),
    trackingLink: z.object({ createdAt: timestamp }).nullable().meta({ description: "The active link's creation time. The token itself is shown only once, when created." }),
  })
  .register(apiRegistry, { id: "Order" });

const pageSchema = z.object({ limit: z.int(), nextCursor: z.string().nullable() });
export const orderListSchema = z.object({ data: z.array(orderSummarySchema), page: pageSchema }).register(apiRegistry, { id: "OrderList" });
export const orderResponseSchema = z.object({ data: orderSchema }).register(apiRegistry, { id: "OrderResponse" });

export const trackingLinkSchema = z
  .object({
    data: z.object({
      orderId: z.uuid(),
      token: z
        .string()
        .nullable()
        .meta({ description: "Shown once. Build the link as `/track#t=<token>` on the site's origin. null on a replay: create another link instead." }),
    }),
  })
  .register(apiRegistry, { id: "TrackingLinkResponse" });

export const deliveryZoneSchema = z
  .object({ code: zone, chargePaisa: paisa(), active: z.boolean(), version, updatedAt: timestamp, updatedByUserId: z.uuid() })
  .register(apiRegistry, { id: "DeliveryZone" });
export const deliveryZoneListSchema = z.object({ data: z.array(deliveryZoneSchema) }).register(apiRegistry, { id: "DeliveryZoneList" });
export const deliveryZoneResponseSchema = z.object({ data: deliveryZoneSchema }).register(apiRegistry, { id: "DeliveryZoneResponse" });

// Inputs.
const expectedVersion = z.int().min(1).max(2_147_483_647).meta({ description: "The order `version` you last read; a stale one gets 409 VERSION_CONFLICT." });
const text = (max: number) => z.string().min(1).max(max);
const amount = z.int().min(1).max(Number.MAX_SAFE_INTEGER).meta({ description: "Integer paisa, positive." });
const date = z.iso.date().meta({ description: "YYYY-MM-DD, not in the future (Asia/Dhaka)." });

export const orderPath = z.strictObject({ orderId: z.uuid() });
export const returnPath = z.strictObject({ orderId: z.uuid(), returnId: z.uuid() });
export const quarantinePath = z.strictObject({ orderId: z.uuid(), quarantineItemId: z.uuid() });
export const zonePath = z.strictObject({ code: zone });

export const orderListQuery = z.strictObject({
  limit: z.string().regex(/^[0-9]{1,3}$/).transform(Number).pipe(z.int().min(1).max(100)).optional(),
  cursor: z.string().min(1).max(200).optional(),
  status: orderStatus.optional(),
  attention: z.enum(["true"]).optional().meta({ description: "Only orders past their verification deadline, expired, or with an open cancellation request." }),
  number: z.string().min(1).max(20).optional().meta({ description: "Order reference, e.g. ORD-000042 or 42. Contact details are not searchable." }),
});

export const createOrderRequest = z
  .strictObject({
    source: z.enum(["messenger", "whatsapp", "other"]).meta({ description: "Assisted channels only; website orders need public checkout, which is not enabled." }),
    customer: z.strictObject({ name: text(100), phone: text(20).meta({ description: "Bangladesh mobile number; +880, 880 or 0 prefixes accepted." }) }),
    deliveryAddress: text(500),
    deliveryZone: zone,
    note: z.string().max(1000).nullable().optional(),
    items: z.array(z.strictObject({ sku: text(64), quantity: z.int().min(1).max(1000) })).min(1).max(20).meta({ description: "Lines for the same SKU are merged." }),
  })
  .meta({ description: "No price or total is accepted: the server computes them from the catalogue and the zone's configured charge." })
  .register(apiRegistry, { id: "CreateOrderRequest" });

export const transitionRequest = z
  .strictObject({
    action: z.enum(["confirm", "pack", "dispatch", "deliver", "mark_rto", "receive_rto", "cancel", "close"]),
    version: expectedVersion,
  })
  .register(apiRegistry, { id: "OrderTransitionRequest" });

export const cancellationReviewRequest = z
  .strictObject({ decision: z.enum(["approve", "reject"]), version: expectedVersion })
  .register(apiRegistry, { id: "CancellationReviewRequest" });

export const paymentRequest = z
  .strictObject({ kind: z.enum(["collected", "settled"]), amountPaisa: amount, occurredOn: date, reference: z.string().max(100).nullable().optional(), version: expectedVersion })
  .register(apiRegistry, { id: "PaymentRequest" });

export const rtoChargeRequest = z.strictObject({ chargePaisa: z.int().min(0).max(1_000_000), version: expectedVersion }).register(apiRegistry, { id: "RtoChargeRequest" });

export const createReturnRequest = z
  .strictObject({
    kind: z.enum(["return", "exchange"]),
    reason: z.enum(["size_or_preference", "wrong_or_defective"]).meta({ description: "Decides who bears return shipping: wrong or defective → business; otherwise the customer." }),
    items: z.array(z.strictObject({ orderItemId: z.uuid(), quantity: z.int().min(1).max(1000) })).min(1).max(20),
    note: z.string().max(500).nullable().optional(),
    version: expectedVersion,
  })
  .register(apiRegistry, { id: "CreateReturnRequest" });

export const returnStepRequest = z
  .discriminatedUnion("step", [
    z.strictObject({ step: z.literal("receive"), returnShippingCostPaisa: z.int().min(0).max(1_000_000).nullable().optional(), version: expectedVersion }),
    z.strictObject({ step: z.literal("approve"), version: expectedVersion }),
    z.strictObject({ step: z.literal("reject"), version: expectedVersion }),
    z.strictObject({ step: z.literal("complete"), version: expectedVersion }),
    z.strictObject({
      step: z.literal("refund"),
      amountPaisa: amount,
      method: z.enum(["bkash", "nagad", "bank_transfer"]),
      occurredOn: date,
      reference: z.string().max(100).nullable().optional(),
      version: expectedVersion,
    }),
  ])
  .register(apiRegistry, { id: "ReturnStepRequest" });

export const inspectionRequest = z
  .strictObject({ outcome: z.enum(["restock", "reject"]), note: z.string().max(500).nullable().optional(), version: expectedVersion })
  .register(apiRegistry, { id: "InspectionRequest" });

export const deliveryZoneRequest = z
  .strictObject({
    chargePaisa: z.int().min(0).max(1_000_000).meta({ description: "Integer paisa, 0 to BDT 10,000 (a technical bound)." }),
    active: z.boolean(),
    version: z.int().min(1).nullable().meta({ description: "null to configure a zone for the first time; otherwise the version you last read." }),
  })
  .register(apiRegistry, { id: "DeliveryZoneRequest" });

// Cursors and mappers.
const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

export const toOrderSummaryDto = (o: Order): z.infer<typeof orderSummarySchema> => ({
  id: o.id,
  reference: formatOrderNumber(o.number),
  source: o.source,
  orderStatus: o.orderStatus,
  fulfilmentStatus: o.fulfilmentStatus,
  paymentStatus: o.paymentStatus,
  returnStatus: o.returnStatus,
  customer: { name: o.customerName, phone: o.customerPhone },
  deliveryZone: o.deliveryZone,
  totalPaisa: o.totalPaisa,
  verificationExpiresAt: iso(o.verificationExpiresAt),
  version: o.version,
  createdAt: iso(o.createdAt),
  updatedAt: iso(o.updatedAt),
});

export const toOrderDto = (o: OrderDetail): z.infer<typeof orderSchema> => ({
  ...toOrderSummaryDto(o),
  deliveryAddress: o.deliveryAddress,
  note: o.note,
  subtotalPaisa: o.subtotalPaisa,
  deliveryChargePaisa: o.deliveryChargePaisa,
  codCollectedPaisa: o.codCollectedPaisa,
  codSettledPaisa: o.codSettledPaisa,
  refundedPaisa: o.refundedPaisa,
  rtoChargePaisa: o.rtoChargePaisa,
  confirmedAt: isoOrNull(o.confirmedAt),
  deliveredAt: isoOrNull(o.deliveredAt),
  closedAt: isoOrNull(o.closedAt),
  items: o.items.map((i) => ({
    id: i.id,
    variantId: i.variantId,
    sku: i.sku,
    name: { en: i.productNameEn, bn: i.productNameBn },
    size: i.size,
    colour: i.colour,
    unitPricePaisa: i.unitPricePaisa,
    quantity: i.quantity,
    lineTotalPaisa: i.lineTotalPaisa,
  })),
  reservations: o.reservations.map((r) => ({ variantId: r.variantId, quantity: r.quantity, status: r.status, releaseReason: r.releaseReason, createdAt: iso(r.createdAt), endedAt: isoOrNull(r.endedAt) })),
  cancellationRequests: o.cancellationRequests.map((r) => ({ id: r.id, status: r.status, reason: r.reason, createdAt: iso(r.createdAt), reviewedAt: isoOrNull(r.reviewedAt) })),
  returns: o.returns.map((r) => ({
    id: r.id,
    kind: r.kind,
    reason: r.reason,
    shippingPaidBy: r.shippingPaidBy,
    returnShippingCostPaisa: r.returnShippingCostPaisa,
    status: r.status,
    note: r.note,
    items: r.items.map((i) => ({ orderItemId: i.orderItemId, quantity: i.quantity })),
    createdAt: iso(r.createdAt),
  })),
  quarantine: o.quarantine.map((q) => ({
    id: q.id,
    orderItemId: q.orderItemId,
    source: q.source,
    returnId: q.returnId,
    quantity: q.quantity,
    status: q.status,
    note: q.note,
    receivedAt: iso(q.receivedAt),
    inspectedAt: isoOrNull(q.inspectedAt),
  })),
  payments: o.payments.map((p) => ({
    id: p.id,
    kind: p.kind,
    amountPaisa: p.amountPaisa,
    occurredOn: p.occurredOn,
    method: p.method,
    reference: p.reference,
    returnId: p.returnId,
    createdAt: iso(p.createdAt),
  })),
  events: o.events.map((e) => ({ id: e.id, event: e.event, actor: { type: e.actorType, ref: e.actorRef }, createdAt: iso(e.createdAt) })),
  trackingLink: o.trackingLink ? { createdAt: iso(o.trackingLink.createdAt) } : null,
});

export const toDeliveryZoneDto = (z0: DeliveryZoneRow): z.infer<typeof deliveryZoneSchema> => ({
  code: z0.code,
  chargePaisa: z0.chargePaisa,
  active: z0.active,
  version: z0.version,
  updatedAt: iso(z0.updatedAt),
  updatedByUserId: z0.updatedByUserId,
});
