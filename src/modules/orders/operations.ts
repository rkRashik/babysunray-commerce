import "server-only";
import { and, eq, lte, sql } from "drizzle-orm";
import type { Db } from "@/db/database";
import { deliveryZones, orders } from "@/db/schema";
import { actorFor, assertPermission, type Principal } from "../auth/principal";
import { DomainError } from "../domain-error";
import { type Once, runOnce } from "../idempotency/service";
import { completeReturn, createReturn, decideReturn, inspectQuarantineItem, recordPayment, recordRefund, receiveReturn } from "./aftercare";
import { type DeliveryZoneRow, setDeliveryZone } from "./delivery";
import { getOrderDetail, type OrderDetail } from "./queries";
import type { DeliveryZone } from "./rules";
import {
  cancelOrder,
  closeOrder,
  confirmOrder,
  deliverOrder,
  dispatchOrder,
  expireOverdueVerifications,
  markRto,
  type NewOrder,
  packOrder,
  receiveRto,
  recordRtoCharge,
  reviewCancellation,
  submitOrder,
} from "./service";
import { createTrackingLink, revokeTrackingLink } from "./tracking";

// Order operations for every client (the /api/v1 routes and the Owner Office). Each checks the permission
// first, records the verified user as the actor, and runs once per idempotency key (ADR-0005). A replay
// returns the order as it is now. Owner transitions name the order version the client saw.

const loadOrder = (db: Db, ref: { orderId: string }) => getOrderDetail(db, ref.orderId);

/**
 * Expired holds never block new work (founder rule D): before reserving, release overdue ones. Cheap when
 * nothing is overdue (one indexed query).
 */
export async function releaseOverdue(db: Db): Promise<void> {
  const [due] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.orderStatus, "pending_verification"), lte(orders.verificationExpiresAt, sql`now()`)))
    .limit(1);
  if (due) await expireOverdueVerifications(db);
}

export async function submitOrderOnce(db: Db, principal: Principal, idempotencyKey: string, input: NewOrder): Promise<Once<OrderDetail>> {
  const user = assertPermission(principal, "orders:write");
  await releaseOverdue(db);
  const request = { ...input, note: input.note ?? null, items: input.items.map((i) => ({ sku: i.sku, quantity: i.quantity })) };
  const run = () =>
    runOnce(
      db,
      { userId: user.userId, operation: "orders.submit", key: idempotencyKey, request },
      async (tx) => ({ orderId: (await submitOrder(tx, request, actorFor(user))).id }),
      loadOrder,
    );
  try {
    return await run();
  } catch (error) {
    // An order may have passed its deadline between the sweep and the reservation: sweep again, retry once.
    if (!(error instanceof DomainError && error.code === "INSUFFICIENT_STOCK")) throw error;
    if ((await expireOverdueVerifications(db)) === 0) throw error;
    return run();
  }
}

type Transition = (tx: Db, orderId: string, expectedVersion: number, actor: ReturnType<typeof actorFor>) => Promise<unknown>;

function transition(operation: string, permission: "orders:write", act: Transition) {
  return async (db: Db, principal: Principal, idempotencyKey: string, input: { orderId: string; expectedVersion: number }): Promise<Once<OrderDetail>> => {
    const user = assertPermission(principal, permission);
    const request = { orderId: input.orderId, expectedVersion: input.expectedVersion };
    return runOnce(
      db,
      { userId: user.userId, operation, key: idempotencyKey, request },
      async (tx) => {
        await act(tx, request.orderId, request.expectedVersion, actorFor(user));
        return { orderId: request.orderId };
      },
      loadOrder,
    );
  };
}

// No sweep before confirming: confirmOrder handles an overdue order itself (release, then reserve again), and a
// sweep would change the version the Owner just saw.
export const confirmOrderOnce = transition("orders.confirm", "orders:write", confirmOrder);
export const cancelOrderOnce = transition("orders.cancel", "orders:write", cancelOrder);
export const packOrderOnce = transition("orders.pack", "orders:write", packOrder);
export const dispatchOrderOnce = transition("orders.dispatch", "orders:write", dispatchOrder);
export const deliverOrderOnce = transition("orders.deliver", "orders:write", deliverOrder);
export const markRtoOnce = transition("orders.rto.mark", "orders:write", markRto);
export const receiveRtoOnce = transition("orders.rto.receive", "orders:write", receiveRto);
export const closeOrderOnce = transition("orders.close", "orders:write", closeOrder);

export async function reviewCancellationOnce(
  db: Db,
  principal: Principal,
  key: string,
  input: { orderId: string; expectedVersion: number; decision: "approve" | "reject" },
): Promise<Once<OrderDetail>> {
  const user = assertPermission(principal, "orders:write");
  const request = { orderId: input.orderId, expectedVersion: input.expectedVersion, decision: input.decision };
  return runOnce(
    db,
    { userId: user.userId, operation: "orders.cancellation.review", key, request },
    async (tx) => {
      await reviewCancellation(tx, request.orderId, request.expectedVersion, request.decision, actorFor(user));
      return { orderId: request.orderId };
    },
    loadOrder,
  );
}

export async function recordRtoChargeOnce(db: Db, principal: Principal, key: string, input: { orderId: string; expectedVersion: number; chargePaisa: number }) {
  const user = assertPermission(principal, "payments:record");
  const request = { ...input };
  return runOnce(
    db,
    { userId: user.userId, operation: "orders.rto.charge", key, request },
    async (tx) => {
      await recordRtoCharge(tx, request.orderId, request.expectedVersion, request.chargePaisa, actorFor(user));
      return { orderId: request.orderId };
    },
    loadOrder,
  );
}

export async function recordPaymentOnce(
  db: Db,
  principal: Principal,
  key: string,
  input: { orderId: string; expectedVersion: number; kind: "collected" | "settled"; amountPaisa: number; occurredOn: string; reference?: string | null },
): Promise<Once<OrderDetail>> {
  const user = assertPermission(principal, "payments:record");
  const request = { ...input, reference: input.reference ?? null };
  return runOnce(
    db,
    { userId: user.userId, operation: "orders.payment", key, request },
    async (tx) => {
      await recordPayment(tx, request.orderId, request.expectedVersion, request, actorFor(user));
      return { orderId: request.orderId };
    },
    loadOrder,
  );
}

export async function createReturnOnce(
  db: Db,
  principal: Principal,
  key: string,
  input: Parameters<typeof createReturn>[3] & { orderId: string; expectedVersion: number },
): Promise<Once<OrderDetail>> {
  const user = assertPermission(principal, "orders:write");
  const request = { ...input, note: input.note ?? null, items: input.items.map((i) => ({ orderItemId: i.orderItemId, quantity: i.quantity })) };
  return runOnce(
    db,
    { userId: user.userId, operation: "orders.return.create", key, request },
    async (tx) => {
      await createReturn(tx, request.orderId, request.expectedVersion, request, actorFor(user));
      return { orderId: request.orderId };
    },
    loadOrder,
  );
}

type ReturnStep =
  | { step: "receive"; returnShippingCostPaisa?: number | null }
  | { step: "approve" }
  | { step: "reject" }
  | { step: "complete" }
  | { step: "refund"; amountPaisa: number; method: "bkash" | "nagad" | "bank_transfer"; occurredOn: string; reference?: string | null };

/** One step of a return: receive into quarantine, decide, refund (payments:record) or complete. */
export async function returnStepOnce(
  db: Db,
  principal: Principal,
  key: string,
  input: { orderId: string; returnId: string; expectedVersion: number } & ReturnStep,
): Promise<Once<OrderDetail>> {
  const user = assertPermission(principal, input.step === "refund" ? "payments:record" : "orders:write");
  const request = { ...input };
  return runOnce(
    db,
    { userId: user.userId, operation: `orders.return.${input.step}`, key, request },
    async (tx) => {
      const actor = actorFor(user);
      const { returnId, expectedVersion } = request;
      if (request.step === "receive") await receiveReturn(tx, returnId, expectedVersion, request, actor);
      else if (request.step === "approve" || request.step === "reject") await decideReturn(tx, returnId, expectedVersion, request.step, actor);
      else if (request.step === "complete") await completeReturn(tx, returnId, expectedVersion, actor);
      else await recordRefund(tx, returnId, expectedVersion, request, actor);
      return { orderId: request.orderId };
    },
    async (tx, ref: { orderId: string }) => {
      const detail = await getOrderDetail(tx, ref.orderId);
      if (!detail.returns.some((r) => r.id === input.returnId)) throw new DomainError("RETURN_NOT_FOUND", "Return not found.");
      return detail;
    },
  );
}

export async function inspectQuarantineOnce(
  db: Db,
  principal: Principal,
  key: string,
  input: { orderId: string; quarantineItemId: string; expectedVersion: number; outcome: "restock" | "reject"; note?: string | null },
): Promise<Once<OrderDetail>> {
  const user = assertPermission(principal, "stock:receive");
  const request = { ...input, note: input.note ?? null };
  return runOnce(
    db,
    { userId: user.userId, operation: "orders.inspect", key, request },
    async (tx) => {
      await inspectQuarantineItem(tx, request.quarantineItemId, request.expectedVersion, request, actorFor(user));
      return { orderId: request.orderId };
    },
    loadOrder,
  );
}

/**
 * Creates a new tracking link (revoking the old one). The token is in the first answer only: a replay with
 * the same key returns `token: null`, because only the token's digest is stored.
 */
export async function createTrackingLinkOnce(db: Db, principal: Principal, key: string, input: { orderId: string }) {
  const user = assertPermission(principal, "orders:write");
  // Assigned inside the operation; the cast keeps TypeScript from narrowing it to null.
  let token = null as string | null;
  const result = await runOnce(
    db,
    { userId: user.userId, operation: "orders.tracking.create", key, request: { orderId: input.orderId } },
    async (tx) => {
      const created = await createTrackingLink(tx, input.orderId, actorFor(user));
      token = created.token;
      return { orderId: input.orderId, tokenId: created.tokenId };
    },
    async (_tx, ref: { orderId: string; tokenId: string }) => ({ orderId: ref.orderId, tokenId: ref.tokenId }),
  );
  return { ...result, value: { ...result.value, token: result.replayed ? null : token } };
}

export async function revokeTrackingLinkOnce(db: Db, principal: Principal, key: string, input: { orderId: string }) {
  const user = assertPermission(principal, "orders:write");
  return runOnce(
    db,
    { userId: user.userId, operation: "orders.tracking.revoke", key, request: { orderId: input.orderId } },
    async (tx) => {
      await revokeTrackingLink(tx, input.orderId, actorFor(user));
      return { orderId: input.orderId };
    },
    loadOrder,
  );
}

export async function setDeliveryZoneOnce(
  db: Db,
  principal: Principal,
  key: string,
  input: { code: DeliveryZone; chargePaisa: number; active: boolean; expectedVersion: number | null },
): Promise<Once<DeliveryZoneRow>> {
  const user = assertPermission(principal, "settings:write");
  const request = { ...input };
  return runOnce(
    db,
    { userId: user.userId, operation: "orders.delivery-zone.set", key, request },
    async (tx) => {
      const zone = await setDeliveryZone(tx, request.code, request, actorFor(user));
      return { code: zone.code, version: zone.version };
    },
    async (tx, ref: { code: DeliveryZone }) => {
      const [zone] = await tx.select().from(deliveryZones).where(eq(deliveryZones.code, ref.code));
      return zone;
    },
  );
}
