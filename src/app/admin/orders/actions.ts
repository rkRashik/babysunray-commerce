"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { readAuthSettings } from "@/modules/auth/settings";
import { bulkTransition, type BulkResult, isBulkAction } from "@/modules/orders/bulk";
import { classifyOrderSearch, isOrderQueue, MAX_ORDER_SEARCH } from "@/modules/orders/queries";
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
import { getOrderDetail } from "@/modules/orders/queries";
import { DELIVERY_ZONES, type DeliveryZone, MAX_ORDER_LINES, verificationOverdue, ZONE_LABELS } from "@/modules/orders/rules";
import { formError, type FormState, optional, taka, text, wholeNumber } from "../_lib/form";
import { requireAdmin } from "../_lib/session";
import { SEARCH_COOKIE, SEARCH_TTL_SECONDS, sealSearch } from "./_lib/search-cookie";

// Admin order actions. Same rules as ../actions.ts: each verifies the session cookie and permission
// itself, reads only its own fields, calls the shared idempotent operation directly (never /api/v1), and
// records the signed-in user as the actor. Order changes carry the version the page was rendered from, so a
// stale tab is refused instead of overriding a newer change.

const oneOf = <T extends string>(raw: string, values: readonly T[], label: string): T => {
  if (!(values as readonly string[]).includes(raw)) throw new DomainError("INVALID_INPUT", `Choose a ${label}.`);
  return raw as T;
};
const orderRef = (form: FormData) => ({ orderId: text(form, "orderId"), expectedVersion: wholeNumber(text(form, "version"), "Version") });
const back = (orderId: string, done: string) => redirect(`/admin/orders/${encodeURIComponent(orderId)}?done=${done}`);

export async function createOrderAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireAdmin("orders:write");
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
  const principal = await requireAdmin("orders:write");
  const action = text(form, "action");
  const ref = { orderId: text(form, "orderId") };
  try {
    if (!Object.hasOwn(TRANSITIONS, action)) throw new DomainError("INVALID_INPUT", "Unknown action.");
    await TRANSITIONS[action as keyof typeof TRANSITIONS](getDb(), principal, text(form, "idempotencyKey"), orderRef(form));
  } catch (error) {
    return formError(error, form);
  }
  // A quick action from the order list returns to the list (its filters are in `list`, a path built by the list itself).
  const list = text(form, "returnTo");
  if (/^\/admin\/orders(\?[A-Za-z0-9=&_%.-]*)?$/.test(list)) redirect(`${list}${list.includes("?") ? "&" : "?"}done=${action}`);
  back(ref.orderId, action);
  return {};
}

const authSecret = () => readAuthSettings(process.env).secret;

/**
 * Applies the list's filters. An order number goes in the URL (it is not personal data); a name or phone number is sealed
 * into the search cookie (_lib/search-cookie.ts) and the URL only says `search=1`. The queue and status chosen on the page are kept.
 */
export async function searchOrdersAction(form: FormData): Promise<void> {
  const principal = await requireAdmin("orders:read");
  const term = text(form, "q").trim();
  const status = text(form, "status");
  const queue = text(form, "queue");
  const params = new URLSearchParams();
  if (/^[a-z_]{1,40}$/.test(status)) params.set("status", status);
  if (isOrderQueue(queue)) params.set("queue", queue);
  if (text(form, "attention") === "true") params.set("attention", "true");
  const search = classifyOrderSearch(term);
  const store = await cookies();
  const base = { name: SEARCH_COOKIE, path: "/admin/orders" };
  if (search?.kind === "number") {
    store.delete(base);
    params.set("number", String(search.number));
  } else if (term) {
    store.set(SEARCH_COOKIE, sealSearch(term.slice(0, MAX_ORDER_SEARCH), principal.userId, authSecret()), {
      httpOnly: true,
      sameSite: "strict",
      path: "/admin/orders",
      maxAge: SEARCH_TTL_SECONDS,
      secure: process.env.NODE_ENV === "production",
    });
    params.set("search", "1");
  } else {
    store.delete(base);
  }
  redirect(params.size ? `/admin/orders?${params}` : "/admin/orders");
}

export async function clearOrderSearchAction(): Promise<void> {
  await requireAdmin("orders:read");
  (await cookies()).delete({ name: SEARCH_COOKIE, path: "/admin/orders" });
  redirect("/admin/orders");
}

/** Called when someone signs out: forgets the order search of this browser at once (it would also expire by itself). */
export async function forgetOrderSearchAction(): Promise<void> {
  (await cookies()).delete({ name: SEARCH_COOKIE, path: "/admin/orders" });
}

export type QuickView = {
  id: string;
  number: number;
  createdAt: string;
  source: string;
  orderStatus: string;
  fulfilmentStatus: string;
  paymentStatus: string;
  returnStatus: string;
  overdue: boolean;
  verificationExpiresAt: string;
  openRequest: boolean;
  customerName: string;
  customerPhone: string;
  deliveryAddress: string;
  zone: string;
  note: string | null;
  items: { sku: string; name: string; size: string | null; colour: string | null; quantity: number; lineTotalPaisa: number }[];
  subtotalPaisa: number;
  deliveryChargePaisa: number;
  totalPaisa: number;
  codCollectedPaisa: number;
  codSettledPaisa: number;
  codDeductedPaisa: number;
  events: { event: string; at: string }[];
};

/** One order's summary for the list's quick-view drawer. The same data as the order page, to the same signed-in Owner, in this response only. */
export async function orderQuickViewAction(orderId: string): Promise<QuickView | { error: string }> {
  await requireAdmin("orders:read");
  try {
    const o = await getOrderDetail(getDb(), orderId);
    return {
      id: o.id,
      number: o.number,
      createdAt: o.createdAt.toISOString(),
      source: o.source,
      orderStatus: o.orderStatus,
      fulfilmentStatus: o.fulfilmentStatus,
      paymentStatus: o.paymentStatus,
      returnStatus: o.returnStatus,
      overdue: verificationOverdue(o, new Date()),
      verificationExpiresAt: o.verificationExpiresAt.toISOString(),
      openRequest: o.cancellationRequests.some((r) => r.status === "open"),
      customerName: o.customerName,
      customerPhone: o.customerPhone,
      deliveryAddress: o.deliveryAddress,
      zone: ZONE_LABELS[o.deliveryZone] ?? o.deliveryZone,
      note: o.note,
      items: o.items.map((i) => ({ sku: i.sku, name: i.productNameEn ?? i.productNameBn ?? i.sku, size: i.size, colour: i.colour, quantity: i.quantity, lineTotalPaisa: i.lineTotalPaisa })),
      subtotalPaisa: o.subtotalPaisa,
      deliveryChargePaisa: o.deliveryChargePaisa,
      totalPaisa: o.totalPaisa,
      codCollectedPaisa: o.codCollectedPaisa,
      codSettledPaisa: o.codSettledPaisa,
      codDeductedPaisa: o.codDeductedPaisa,
      events: o.events.slice(-5).map((e) => ({ event: e.event, at: e.createdAt.toISOString() })),
    };
  } catch (error) {
    if (error instanceof DomainError) return { error: "This order could not be found." };
    throw error;
  }
}

export type BulkState = { results?: BulkResult[]; error?: string };

/** Packs, dispatches or marks delivered the selected orders, each by itself (bulk.ts), and answers with one result per order. */
export async function bulkOrdersAction(_: BulkState, form: FormData): Promise<BulkState> {
  const principal = await requireAdmin("orders:write");
  try {
    const action = text(form, "bulkAction");
    if (!isBulkAction(action)) throw new DomainError("INVALID_INPUT", "Choose a step for the selected orders.");
    const items = form.getAll("order").map((entry) => {
      const [orderId, version] = String(entry).split(":");
      return { orderId, expectedVersion: wholeNumber(version ?? "", "Version") };
    });
    const results = await bulkTransition(getDb(), principal, text(form, "batch"), action, items);
    revalidatePath("/admin/orders");
    return { results };
  } catch (error) {
    return { error: formError(error, form).error };
  }
}

export async function reviewCancellationAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireAdmin("orders:write");
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
  const principal = await requireAdmin("payments:record");
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
  const principal = await requireAdmin("payments:record");
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
  const principal = await requireAdmin("orders:write");
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
  const principal = await requireAdmin(step === "refund" ? "payments:record" : "orders:write");
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
  const principal = await requireAdmin("stock:receive");
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
  const principal = await requireAdmin("orders:write");
  try {
    const { value } = await createTrackingLinkOnce(getDb(), principal, text(form, "idempotencyKey"), { orderId: text(form, "orderId") });
    if (!value.token) return { error: "This link was already created and cannot be shown again. Reload the page and create a new one." };
    return { link: `${getAuth().options.baseURL}/track#t=${value.token}` };
  } catch (error) {
    return formError(error, form);
  }
}

export async function revokeTrackingLinkAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireAdmin("orders:write");
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
  const principal = await requireAdmin("settings:write");
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
  redirect("/admin/settings/delivery?done=zone-saved");
}
