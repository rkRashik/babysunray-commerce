import type { PolicyKind } from "./drafts";

// Questions to answer when writing each customer policy. Guidance for the Owner, shown beside the editor; it is
// never inserted into a draft and is not policy text. "decided" restates what the founder already approved (with
// the rule in docs/product/order-policy-decisions.md or the requirement), or what the system does today ("as
// built"); "open" is what nobody has decided. No answer is suggested for an open question.

export type ChecklistItem = { topic: string; decided: string | null; open: string | null; source: string };

export const POLICY_CHECKLIST: Record<PolicyKind, ChecklistItem[]> = {
  delivery: [
    { topic: "Delivery zones and charges", decided: "Two zones, Dhaka City and Outside Dhaka, each with a charge you configure.", open: "Which areas count as Dhaka City, and the amount for each zone.", source: "Rule I, O-8" },
    { topic: "When the charge is shown", decided: "The delivery charge is shown before the customer submits the order.", open: null, source: "S-7, rule I" },
    { topic: "Verification", decided: "Every order starts as Pending Verification. You verify it yourself by phone, Messenger or WhatsApp. If it is not verified within 24 hours, its reserved stock is released.", open: "How and when the customer will be contacted.", source: "Rules B and D" },
    { topic: "Payment", decided: "Cash on delivery at launch.", open: "Whether any advance payment is ever asked for.", source: "S-4" },
    { topic: "Delivery time", decided: null, open: "Delivery times per zone. Do not promise any until decided.", source: "Not decided" },
    { topic: "Courier and tracking", decided: "Customers follow their order through a private link; no account is needed.", open: "Which courier(s), and what courier information the customer receives.", source: "Rule K" },
  ],
  returns: [
    { topic: "Request period", decided: "Return or exchange requests within 7 days after delivery.", open: null, source: "Rule E" },
    { topic: "Condition", decided: "For a size or preference change: unused, unwashed, tags intact. Wrong or defective items are exempt.", open: "What counts as wrong or defective.", source: "Rule E" },
    { topic: "Inspection", decided: "Returned goods are inspected before any exchange or refund decision.", open: "Inspection criteria beyond pass or fail.", source: "Rule E, decision 9" },
    { topic: "Return shipping", decided: "The business pays for a wrong or defective item; the customer pays for a size or preference change.", open: "The cost, and how the customer sends the item back.", source: "Rule F" },
    { topic: "Refunds", decided: "After inspection and your approval, refunded by hand through bKash, Nagad or bank transfer within 7 working days. Money not collected is never refunded.", open: "Which days count as working days.", source: "Rule M" },
    { topic: "Exchanges", decided: null, open: "Who pays the replacement's delivery, and how a price difference is handled. (Today the Office records the exchange and you create a new order for the replacement: an engineering default, not a rule.)", source: "Order policy, sections 3 and 4" },
    { topic: "Cancellation", decided: "Pending Verification: the customer may cancel through the private link. Confirmed but not dispatched: the customer may ask, and you decide. After dispatch: return or refused parcel rules apply.", open: null, source: "Rule C" },
    { topic: "Refused or undelivered parcels", decided: "Returned parcels are inspected before anything goes back into stock.", open: "Whether a customer who refuses a parcel is charged anything.", source: "Rule G" },
  ],
  privacy: [
    { topic: "What checkout collects", decided: "As built: name, Bangladesh mobile number and delivery address. No account, password or card details.", open: "Whether anything else will be collected.", source: "S-3, S-4" },
    { topic: "Who can see it", decided: "As built: only you, signed in to the Owner Office.", open: "Whether staff, couriers or anyone else will see customer details.", source: "OF-4, OF-7" },
    { topic: "Order tracking", decided: "A private random link that shows masked details only; it stops working 30 days after the order is closed, and you can revoke it.", open: null, source: "Rules K and N, S-15" },
    { topic: "Analytics and cookies", decided: "As built: no analytics, advertising or tracking scripts.", open: "Whether any will be added.", source: "S-10" },
    { topic: "Keeping and deleting data", decided: "As built: encrypted local backups exist.", open: "How long orders and customer details are kept, and how a customer asks to see, correct or delete theirs.", source: "K-8, not decided" },
    { topic: "Legal review", decided: null, open: "Which Bangladesh law applies and what it requires. This needs advice from a qualified person.", source: "Not decided" },
  ],
  checkout_notices: [
    { topic: "Received is not confirmed", decided: "After submitting, the order is received and waits for your verification; it is not confirmed yet.", open: "The exact words the customer sees.", source: "S-8, rule B" },
    { topic: "Stock is held", decided: "Items are reserved when the order is submitted; an unverified order releases them after 24 hours.", open: "Whether and how to tell the customer.", source: "Rules A and D" },
    { topic: "Total before submitting", decided: "The customer sees the item prices, the delivery charge and the cash-on-delivery total before submitting.", open: null, source: "S-7" },
    { topic: "Contact route", decided: "If the order cannot be recorded, the page says so and offers a manual contact route.", open: "Which phone, Messenger or WhatsApp contact is shown.", source: "S-12" },
    { topic: "Terms of sale", decided: null, open: "Whether separate terms of sale are needed. Founder and legal decision.", source: "S-17" },
  ],
};
