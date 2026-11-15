// The storewide activation barrier (Gate H.26). One place answers "may the public shop open?", and in this version
// the answer is always no. Public checkout stays disabled until the founder has approved and PUBLISHED the
// delivery, return/exchange and privacy policies (S-17, G-7), and the launch needs decisions this system cannot
// record (hosting, recovery objectives, abuse protection, a publication rule). There is deliberately no switch,
// environment variable, setting or Office action that opens it: `open` is the literal `false`, and opening it is a
// founder-approved code change in a later gate. Pure functions, so the Office page and the tests share them.

export type PolicyState = "empty" | "drafted" | "reviewed";
export type LaunchFacts = {
  policies: { delivery: PolicyState; returns: PolicyState; privacy: PolicyState; checkout_notices: PolicyState };
  /** Both founder-approved zones (rule I) have an active Owner-configured charge. */
  deliveryZonesConfigured: boolean;
  /** Draft products whose current content has an internal review. */
  reviewedProducts: number;
};

export type GateBlocker = { id: string; requirement: string; reason: string; next: string };
export type PublicCheckoutGate = { open: false; blockers: GateBlocker[] };

const POLICY_NAMES = { delivery: "delivery", returns: "return and exchange", privacy: "privacy", checkout_notices: "checkout notices" } as const;

/** Why public checkout (and with it the public shop) is closed, in the order the founder would resolve them. */
export function publicCheckoutGate(facts: LaunchFacts): PublicCheckoutGate {
  const blockers: GateBlocker[] = [];
  for (const kind of ["delivery", "returns", "privacy"] as const) {
    if (facts.policies[kind] === "empty") {
      blockers.push({ id: `policy_${kind}_missing`, requirement: "S-17, G-7", reason: `No ${POLICY_NAMES[kind]} policy has been drafted.`, next: "Write it in Policy drafts, in English and Bangla." });
    }
  }
  // Unconditional: no published state exists, so a reviewed draft never satisfies the gate.
  blockers.push({
    id: "policies_not_published",
    requirement: "S-17, G-7",
    reason: "No customer policy is founder-approved and published. This version has no way to publish one; a reviewed draft is not a published policy.",
    next: "Founder approves the final wording; a later gate builds publication.",
  });
  if (!facts.deliveryZonesConfigured) {
    blockers.push({ id: "delivery_charges", requirement: "O-8, rule I", reason: "Dhaka City and Outside Dhaka do not both have an active delivery charge.", next: "Set the real charges in Delivery charges." });
  }
  blockers.push({
    id: "publication_rule",
    requirement: "I-6, open decision 4",
    reason: "No rule for publishing products is approved and no public catalogue exists; every product is a draft.",
    next: "Founder decides what makes a product publishable; a later gate builds published-only reads.",
  });
  if (facts.reviewedProducts === 0) {
    blockers.push({ id: "no_reviewed_products", requirement: "engineering default", reason: "No product has a current internal review.", next: "Review products in Product reviews." });
  }
  blockers.push({
    id: "abuse_protection",
    requirement: "S-15, API-11, open decision 1",
    reason: "An anonymous order holds stock for 24 hours. Without a per-client limit, which needs a trusted proxy from the hosting decision, one visitor could hold all stock.",
    next: "Choose hosting; then design and test per-client limits for checkout.",
  });
  blockers.push({ id: "hosting", requirement: "G-8, open decision 1", reason: "No production host is chosen or verified for commercial use, limits and restore.", next: "Founder chooses hosting (C-1 to C-3)." });
  blockers.push({ id: "recovery_objectives", requirement: "K-9, G-6, open decision 6", reason: "No RPO or RTO is approved, so no backup schedule or off-device copy can be set.", next: "Founder approves RPO and RTO." });
  blockers.push({ id: "transport", requirement: "S-17", reason: "No public checkout endpoint exists; the guest checkout service is built and tested but nothing calls it.", next: "Built only in the gate that opens checkout." });
  return { open: false, blockers };
}
