// The storewide activation barrier (Gate H.26). One place answers "may the PUBLIC shop open?", and in this version the
// answer is always no. Public checkout stays disabled until the founder has approved and PUBLISHED the delivery,
// return/exchange and privacy policies (S-17, G-7), and the launch needs decisions this system cannot record (a publication
// rule, recovery objectives, the production database, the launch itself). There is deliberately no switch, environment
// variable, setting or Office action that opens it: `open` is the literal `false`, and opening it is a founder-approved code
// change. Founder acceptance (acceptance.ts) is separate: it never opens this gate. Pure functions, so the Office page and
// the tests share them.

export type PolicyState = "empty" | "drafted" | "reviewed" | "published";
export type LaunchFacts = {
  policies: { delivery: PolicyState; returns: PolicyState; privacy: PolicyState; checkout_notices: PolicyState };
  /** Both founder-approved zones (rule I) have an active Owner-configured charge. */
  deliveryZonesConfigured: boolean;
  /** Products with a current internal review, or published (a publication needs one). */
  reviewedProducts: number;
};

export type GateBlocker = { id: string; requirement: string; reason: string; next: string };
export type PublicCheckoutGate = { open: false; blockers: GateBlocker[] };

const POLICY_NAMES = { delivery: "delivery", returns: "return and exchange", privacy: "privacy", checkout_notices: "checkout notices" } as const;

/**
 * Whether the public shop may answer a request, decided with no data at all (so a closed shop never touches the database
 * or storage). It asks the gate with the most closed facts, so it can only be open if the gate itself ever opens.
 */
export const publicShopGate = (): { open: boolean } => ({
  open: publicCheckoutGate({ policies: { delivery: "empty", returns: "empty", privacy: "empty", checkout_notices: "empty" }, deliveryZonesConfigured: false, reviewedProducts: 0 }).open,
});

/** Why public checkout (and with it the public shop) is closed, in the order the founder would resolve them. */
export function publicCheckoutGate(facts: LaunchFacts): PublicCheckoutGate {
  const blockers: GateBlocker[] = [];
  for (const kind of ["delivery", "returns", "privacy"] as const) {
    if (facts.policies[kind] === "empty") {
      blockers.push({ id: `policy_${kind}_missing`, requirement: "S-17, G-7", reason: `No ${POLICY_NAMES[kind]} policy has been drafted.`, next: "Write it in Policy drafts, in English and Bangla." });
    }
  }
  const unpublished = (["delivery", "returns", "privacy"] as const).filter((kind) => facts.policies[kind] !== "published");
  if (unpublished.length) {
    blockers.push({
      id: "policies_not_published",
      requirement: "S-17, G-7",
      reason: `Not published: the ${unpublished.map((k) => POLICY_NAMES[k]).join(", ")} ${unpublished.length === 1 ? "policy" : "policies"}. A reviewed draft is not a published policy.`,
      next: "Founder approves the final wording and publishes it in Policies.",
    });
  }
  if (!facts.deliveryZonesConfigured) {
    blockers.push({ id: "delivery_charges", requirement: "O-8, rule I", reason: "Dhaka City and Outside Dhaka do not both have an active delivery charge.", next: "Set the real charges in Delivery charges." });
  }
  blockers.push({
    id: "publication_rule",
    requirement: "I-6, open decision 4",
    reason: "No rule for publishing products is approved for the public shop. The proposed rule applies only to founder acceptance on the staging database.",
    next: "Founder approves the proposed rule (or a changed one); the approved rule is then set in code (APPROVED_PUBLICATION_RULE).",
  });
  if (facts.reviewedProducts === 0) {
    blockers.push({ id: "no_reviewed_products", requirement: "engineering default", reason: "No product has a current internal review.", next: "Review products in Product reviews." });
  }
  blockers.push({
    id: "abuse_protection",
    requirement: "S-15, API-11, open decision 1",
    reason: "An anonymous order holds stock for 24 hours. Per-client checkout and sign-in limits are built for Netlify (TRUSTED_PROXY=netlify) but not yet verified with real traffic on the live site.",
    next: "Set TRUSTED_PROXY=netlify, then check the limits on the live site during acceptance.",
  });
  blockers.push({ id: "production_database", requirement: "G-8, ADR-0010", reason: "The production Supabase project does not exist yet; the site runs on the staging database (the founder creates production last).", next: "Founder creates the production project; migrate, configure and verify it (production-migration.md)." });
  blockers.push({ id: "recovery_objectives", requirement: "K-9, G-6, open decision 6", reason: "No RPO or RTO is approved, so no backup schedule or off-device copy can be set.", next: "Founder approves RPO and RTO." });
  blockers.push({ id: "launch_approval", requirement: "S-17", reason: "The founder has not approved the public launch. The shop and its checkout are built and answer only founder acceptance on the staging database.", next: "After acceptance and the items above, the founder approves the launch; opening this gate is then a reviewed code change." });
  return { open: false, blockers };
}
