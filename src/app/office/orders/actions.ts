"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { getAuth } from "@/modules/auth/server";
import { DomainError } from "@/modules/domain-error";
import {
  cancelOrderOnce,
  closeOrderOnce,
  confirmOrderOnce,
  createReturnOnce,
  createTrackingLinkOnce,
  deliverOrderOnce,
  dispatchOrderOnce,
  inspectQuarantineOnce,
  markRtoOnce,
  packOrderOnce,
  receiveRtoOnce,
  recordPaymentOnce,
  recordRtoChargeOnce,
  returnStepOnce,
  revokeTrackingLinkOnce,
  reviewCancellationOnce,
  setDeliveryZoneOnce,
  submitOrderOnce,
} from "@/modules/orders/operations";
import { DELIVERY_ZONES, type DeliveryZone, MAX_ORDER_LINES } from "@/modules/orders/rules";
import { formError, type FormState, optional, taka, text, wholeNumber } from "../_lib/form";
import { requireOffice } from "../_lib/session";

// Owner Office order actions. Same rules as ../actions.ts: each verifies the session cookie and permission
// itself, reads only its own fields, calls the shared idempotent operation directly (never /api/v1), and
// records the signed-in user as the actor. Order changes carry the version the page was rendered from, so a
// stale tab is refused instead of overriding a newer change.

const oneOf = <T extends string>(raw: string, values: readonly T[], label: string): T => {
  if (!(values as readonly string[]).includes(raw)) throw new DomainError("INVALID_INPUT", `Choose a ${label}.`);
  return raw as T;
};
const orderRef = (form: FormData) => ({ orderId: text(form, "orderId"), expectedVersion: wholeNumber(text(form, "version"), "Version") });
const back = (orderId: string, done: string) => redirect(`/office/orders/${encodeURIComponent(orderId)}?done=${done}`);

export async function createOrderAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireOffice("orders:write");
  let orderId: string;
  try {
    const items: { sku: string; quantity: number }[] = [];
    // A "use server" file may export only async functions; the page decides how many lines it shows.
    for (let i = 0; i < MAX_ORDER_LINES; i += 1) {
      const sku = text(form, `sku${i}`).trim();
      const quantity = text(form, `qty${i}`).trim();
      if (!sku && !quantity) continue;
      if (!sku) throw new DomainError("INVALID_INPUT", `Line ${i + 1}: enter a SKU or clear the quantity.`);
      items.push({ sku, quantity: wholeNumber(quantity || "", `Line ${i + 1} quantity`) });
    }
    if (items.length === 0) throw new DomainError("INVALID_INPUT", "Add at least one SKU and quantity.");
    const { value } = await submitOrderOnce(getDb(), principal, text(form, "idempotencyKey"), {
      source: oneOf(text(form, "source"), ["messenger", "whatsapp", "other"] as const, "source"),
      customerName: text(form, "customerName"),
      customerPhone: text(form, "customerPhone"),
      deliveryAddress: text(form, "deliveryAddress"),
      deliveryZone: oneOf(text(form, "deliveryZone"), DELIVERY_ZONES, "delivery zone"),
      note: optional(form, "note"),
      items,
    });
    orderId = value.id;
  } catch (error) {
    return formError(error, form);
  }
  back(orderId, "order-created");
  return {};
}

const TRANSITIONS = {
  confirm: confirmOrderOnce,
  pack: packOrderOnce,
  dispatch: dispatchOrderOnce,
  deliver: deliverOrderOnce,
  mark_rto: markRtoOnce,
  receive_rto: receiveRtoOnce,
  cancel: cancelOrderOnce,
  close: closeOrderOnce,
} as const;

export async function orderTransitionAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireOffice("orders:write");
  const action = text(form, "action");
  const ref = { orderId: text(form, "orderId") };
  try {
    if (!Object.hasOwn(TRANSITIONS, action)) throw new DomainError("INVALID_INPUT", "Unknown action.");
    await TRANSITIONS[action as keyof typeof TRANSITIONS](getDb(), principal, text(form, "idempotencyKey"), orderRef(form));
  } catch (error) {
    return formError(error, form);
  }
  back(ref.orderId, action);
  return {};
}

export async function reviewCancellationAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireOffice("orders:write");
  const decision = text(form, "decision") === "approve" ? "approve" : "reject";
  const ref = orderRef(form);
  try {
    await reviewCancellationOnce(getDb(), principal, text(form, "idempotencyKey"), { ...ref, decision });
  } catch (error) {
    return formError(error, form);
  }
  back(ref.orderId, decision === "approve" ? "request-approved" : "request-rejected");
  return {};
}

export async function recordPaymentAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireOffice("payments:record");
  const orderId = text(form, "orderId");
  try {
    await recordPaymentOnce(getDb(), principal, text(form, "idempotencyKey"), {
      ...orderRef(form),
      kind: oneOf(text(form, "kind"), ["collected", "settled", "deducted"] as const, "payment kind"),
      amountPaisa: taka(form, "amountTaka", "Amount"),
      occurredOn: text(form, "occurredOn"),
      reference: optional(form, "reference"),
    });
  } catch (error) {
    return formError(error, form);
  }
  back(orderId, "payment");
  return {};
}

export async function rtoChargeAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireOffice("payments:record");
  const orderId = text(form, "orderId");
  try {
    await recordRtoChargeOnce(getDb(), principal, text(form, "idempotencyKey"), { ...orderRef(form), chargePaisa: taka(form, "chargeTaka", "RTO charge") });
  } catch (error) {
    return formError(error, form);
  }
  back(orderId, "rto-charge");
  return {};
}

export async function createReturnAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireOffice("orders:write");
  const orderId = text(form, "orderId");
  try {
    const items: { orderItemId: string; quantity: number }[] = [];
    for (let i = 0; i < MAX_ORDER_LINES; i += 1) {
      const id = text(form, `itemId${i}`);
      const quantity = text(form, `itemQty${i}`).trim();
      if (!id || !quantity || quantity === "0") continue;
      items.push({ orderItemId: id, quantity: wholeNumber(quantity, "Quantity") });
    }
    if (items.length === 0) throw new DomainError("INVALID_INPUT", "Enter how many of at least one item come back.");
    await createReturnOnce(getDb(), principal, text(form, "idempotencyKey"), {
      ...orderRef(form),
      kind: oneOf(text(form, "kind"), ["return", "exchange"] as const, "return or exchange"),
      reason: oneOf(text(form, "reason"), ["size_or_preference", "wrong_or_defective"] as const, "reason"),
      items,
      note: optional(form, "note"),
    });
  } catch (error) {
    return formError(error, form);
  }
  back(orderId, "return-created");
  return {};
}

export async function returnStepAction(_: FormState, form: FormData): Promise<FormState> {
  const step = text(form, "step");
  const principal = await requireOffice(step === "refund" ? "payments:record" : "orders:write");
  const orderId = text(form, "orderId");
  try {
    const ref = { ...orderRef(form), returnId: text(form, "returnId") };
    const key = text(form, "idempotencyKey");
    if (step === "receive") {
      const cost = text(form, "costTaka").trim();
      await returnStepOnce(getDb(), principal, key, { ...ref, step, returnShippingCostPaisa: cost ? taka(form, "costTaka", "Return shipping cost") : null });
    } else if (step === "approve" || step === "reject" || step === "complete") {
      await returnStepOnce(getDb(), principal, key, { ...ref, step });
    } else if (step === "refund") {
      await returnStepOnce(getDb(), principal, key, {
        ...ref,
        step,
        amountPaisa: taka(form, "amountTaka", "Refund amount"),
        method: oneOf(text(form, "method"), ["bkash", "nagad", "bank_transfer"] as const, "refund method"),
        occurredOn: text(form, "occurredOn"),
        reference: optional(form, "reference"),
      });
    } else {
      throw new DomainError("INVALID_INPUT", "Unknown step.");
    }
  } catch (error) {
    return formError(error, form);
  }
  back(orderId, "return-step");
  return {};
}

export async function inspectAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireOffice("stock:receive");
  const orderId = text(form, "orderId");
  try {
    await inspectQuarantineOnce(getDb(), principal, text(form, "idempotencyKey"), {
      ...orderRef(form),
      quarantineItemId: text(form, "quarantineItemId"),
      outcome: oneOf(text(form, "outcome"), ["restock", "reject"] as const, "inspection result"),
      note: optional(form, "note"),
    });
  } catch (error) {
    return formError(error, form);
  }
  back(orderId, "inspected");
  return {};
}

/**
 * Creates a new tracking link and answers with it in the form state, never in a URL: the token exists only in
 * this one response (the database stores its digest).
 */
export async function createTrackingLinkAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireOffice("orders:write");
  try {
    const { value } = await createTrackingLinkOnce(getDb(), principal, text(form, "idempotencyKey"), { orderId: text(form, "orderId") });
    if (!value.token) return { error: "This link was already created and cannot be shown again. Reload the page and create a new one." };
    return { link: `${getAuth().options.baseURL}/track#t=${value.token}` };
  } catch (error) {
    return formError(error, form);
  }
}

export async function revokeTrackingLinkAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireOffice("orders:write");
  const orderId = text(form, "orderId");
  try {
    await revokeTrackingLinkOnce(getDb(), principal, text(form, "idempotencyKey"), { orderId });
  } catch (error) {
    return formError(error, form);
  }
  back(orderId, "link-revoked");
  return {};
}

export async function setDeliveryZoneAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireOffice("settings:write");
  try {
    const version = text(form, "version");
    await setDeliveryZoneOnce(getDb(), principal, text(form, "idempotencyKey"), {
      code: oneOf(text(form, "code"), DELIVERY_ZONES, "zone") as DeliveryZone,
      chargePaisa: taka(form, "chargeTaka", "Charge"),
      active: text(form, "active") === "on",
      expectedVersion: version ? wholeNumber(version, "Version") : null,
    });
  } catch (error) {
    return formError(error, form);
  }
  redirect("/office/settings/delivery?done=zone-saved");
}
