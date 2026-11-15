import { describe, expect, it } from "vitest";
import {
  allowedActions,
  formatOrderNumber,
  maskName,
  maskPhone,
  normalizeBdPhone,
  type OrderState,
  parseOrderNumber,
  paymentStatusFor,
  trackingLinkLive,
  validatePastDate,
  verificationOverdue,
} from "../../src/modules/orders/rules";

const NOW = new Date("2026-11-15T06:00:00Z");
const HOUR = 3_600_000;
const base: OrderState = {
  orderStatus: "pending_verification",
  fulfilmentStatus: "unfulfilled",
  verificationExpiresAt: new Date(NOW.getTime() + HOUR),
  deliveredAt: null,
  totalPaisa: 10_000,
  codCollectedPaisa: 0,
  codSettledPaisa: 0,
  openCancellationRequest: false,
  openReturn: false,
  awaitingInspection: false,
};
const actions = (s: Partial<OrderState>) => [...allowedActions({ ...base, ...s }, NOW)].sort();

describe("allowedActions (the transition table in order-policy-decisions.md)", () => {
  it("pending and expired orders can be confirmed or cancelled; only pending ones by the customer", () => {
    expect(actions({})).toEqual(["cancel", "confirm", "customer_cancel"]);
    expect(actions({ orderStatus: "verification_expired" })).toEqual(["cancel", "confirm"]);
  });

  it("confirmed orders: pack, then dispatch; customers may only request cancellation before dispatch", () => {
    expect(actions({ orderStatus: "confirmed" })).toEqual(["cancel", "customer_request_cancellation", "pack"]);
    expect(actions({ orderStatus: "confirmed", fulfilmentStatus: "packed" })).toEqual(["cancel", "customer_request_cancellation", "dispatch"]);
    // An open request blocks dispatch and a second request, and asks for the Owner's review.
    expect(actions({ orderStatus: "confirmed", fulfilmentStatus: "packed", openCancellationRequest: true })).toEqual(["cancel", "review_cancellation"]);
  });

  it("dispatched orders cannot be cancelled by anyone; they are delivered or returned to sender", () => {
    expect(actions({ orderStatus: "confirmed", fulfilmentStatus: "dispatched" })).toEqual(["deliver", "mark_rto", "record_collection"]);
    expect(actions({ orderStatus: "confirmed", fulfilmentStatus: "rto" })).toEqual(["receive_rto", "record_rto_charge"]);
  });

  it("returns are possible for 7 × 24 hours after delivery; closing needs settlement and no open aftercare", () => {
    const deliveredAt = new Date(NOW.getTime() - 2 * HOUR);
    expect(actions({ orderStatus: "confirmed", fulfilmentStatus: "delivered", deliveredAt })).toEqual(["close", "create_return", "record_collection"]);
    expect(actions({ orderStatus: "confirmed", fulfilmentStatus: "delivered", deliveredAt: new Date(NOW.getTime() - 7 * 24 * HOUR - 1) })).not.toContain("create_return");
    expect(actions({ orderStatus: "confirmed", fulfilmentStatus: "delivered", deliveredAt, codCollectedPaisa: 10_000, codSettledPaisa: 5_000 })).toEqual(["create_return", "record_settlement"]);
    expect(actions({ orderStatus: "confirmed", fulfilmentStatus: "delivered", deliveredAt, openReturn: true })).not.toContain("close");
    expect(actions({ orderStatus: "confirmed", fulfilmentStatus: "rto_received", awaitingInspection: true })).toEqual(["record_rto_charge"]);
    expect(actions({ orderStatus: "confirmed", fulfilmentStatus: "rto_received" })).toEqual(["close", "record_rto_charge"]);
  });

  it("cancelled and closed orders allow nothing", () => {
    expect(actions({ orderStatus: "cancelled" })).toEqual([]);
    expect(actions({ orderStatus: "closed", fulfilmentStatus: "delivered" })).toEqual([]);
  });

  it("counts 24 elapsed hours, not calendar days", () => {
    expect(verificationOverdue({ orderStatus: "pending_verification", verificationExpiresAt: NOW }, NOW)).toBe(true);
    expect(verificationOverdue({ orderStatus: "pending_verification", verificationExpiresAt: new Date(NOW.getTime() + 1) }, NOW)).toBe(false);
    expect(verificationOverdue({ orderStatus: "confirmed", verificationExpiresAt: new Date(0) }, NOW)).toBe(false);
  });
});

describe("Bangladesh phone numbers", () => {
  it("normalises the accepted forms to 01XXXXXXXXX", () => {
    for (const raw of ["01711000001", "+8801711000001", "8801711000001", "0171-100-0001", " 0171 1000001 ", "1711000001"]) {
      expect(normalizeBdPhone(raw)).toBe("01711000001");
    }
  });
  it("refuses other numbers without echoing them", () => {
    for (const raw of ["01211000001", "0171100000", "017110000011", "+441711000001", "abc", ""]) {
      expect(() => normalizeBdPhone(raw)).toThrow("phone must be a Bangladesh mobile number");
    }
  });
});

describe("money, dates, references and masking", () => {
  it("derives payment status from the amounts", () => {
    expect([paymentStatusFor(100, 0, 0), paymentStatusFor(100, 40, 40), paymentStatusFor(100, 100, 40), paymentStatusFor(100, 100, 100)]).toEqual([
      "unpaid",
      "partially_collected",
      "collected",
      "settled",
    ]);
  });
  it("accepts only real, past or present calendar dates", () => {
    expect(validatePastDate("2026-11-15", "d", "2026-11-15")).toBe("2026-11-15");
    for (const bad of ["2026-11-16", "2026-02-30", "15/11/2026", "2026-1-1"]) expect(() => validatePastDate(bad, "d", "2026-11-15")).toThrow();
  });
  it("formats and parses order numbers, never treating anything else as one", () => {
    expect(formatOrderNumber(42)).toBe("ORD-000042");
    for (const raw of ["ORD-000042", "ord42", "#42", "42", " 000042 "]) expect(parseOrderNumber(raw)).toBe(42);
    for (const raw of ["ORD-", "abc", "01711000001x", "4 2"]) expect(parseOrderNumber(raw)).toBeNull();
  });
  it("masks customer details for the tracking page", () => {
    expect(maskName("রহিমা খাতুন")).toBe("র***");
    expect(maskPhone("01711000001")).toBe("017******01");
  });
  it("tracking links live until revoked, or 30 days after closing", () => {
    const closed = new Date(NOW.getTime() - 29 * 24 * HOUR);
    expect(trackingLinkLive(null, null, NOW)).toBe(true);
    expect(trackingLinkLive(closed, null, NOW)).toBe(true);
    expect(trackingLinkLive(new Date(NOW.getTime() - 30 * 24 * HOUR), null, NOW)).toBe(false);
    expect(trackingLinkLive(null, new Date(0), NOW)).toBe(false);
  });
});
