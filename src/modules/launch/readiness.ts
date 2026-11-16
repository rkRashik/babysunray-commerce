import "server-only";
import { type SQL, sql } from "drizzle-orm";
import type { Db } from "@/db/database";
import { deliveryZones, guestCheckoutSubmissions, inventoryBalances, orders, policyDrafts, productReviews, products, stockMovements, stockReservations, variants } from "@/db/schema";
import { assertPermission, type Principal } from "../auth/principal";
import { MET } from "../catalogue/preparation";
import { APPROVED_PUBLICATION_RULE } from "../catalogue/publication";
import { contentDigest } from "../catalogue/review";
import { DELIVERY_ZONES } from "../orders/rules";
import { POLICY_KINDS, POLICY_TITLES, type PolicyKind, type PolicyStatus } from "../policies/drafts";
import { type LaunchFacts, publicCheckoutGate, type PublicCheckoutGate } from "./gate";

// The Launch Readiness overview (Gate H.26): what must be true before the public shop can open, checked against
// live data where the system can check it, and stated plainly where it cannot. No percentage, score or target.
// A passing test or a checkbox is never shown as proof that a policy is approved or a host is safe: those rows say
// "Requires founder approval" until the founder decides, whatever the data says. Read-only.

export type CheckStatus = "ready" | "incomplete" | "founder_approval" | "not_verified" | "not_applicable";
export type ReadinessCheck = { id: string; label: string; status: CheckStatus; evidence: string; next: string | null; source: string; href?: string };
export type ReadinessSection = { id: "catalogue" | "commerce" | "policies" | "operations"; title: string; checks: ReadinessCheck[] };
export type LaunchReadiness = { sections: ReadinessSection[]; gate: PublicCheckoutGate; drafts: number };

const n = (value: unknown) => Number(value);
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Counts over draft products for the catalogue rows. One query. */
async function catalogueCounts(db: Db) {
  const unmet = (condition: SQL) => sql<number>`count(*) filter (where not ${condition})`.mapWith(Number);
  const [row] = await db
    .select({
      drafts: sql<number>`count(*)`.mapWith(Number),
      name: unmet(MET.name),
      description: unmet(MET.description),
      variant: unmet(MET.variant),
      measurements: unmet(MET.measurements),
      fabric: unmet(MET.fabric),
      care: unmet(MET.care),
      category: unmet(MET.category),
      photo: unmet(MET.photo),
      alt: unmet(MET.alt),
      noStock: unmet(
        sql`exists (select 1 from ${variants} v join ${inventoryBalances} b on b.variant_id = v.id where v.product_id = ${products.id} and v.status = 'active' and b.on_hand - b.reserved > 0)`,
      ),
      reviewed: sql<number>`count(*) filter (where (select r.content_sha256 from ${productReviews} r where r.product_id = ${products.id} order by r.created_at desc, r.id desc limit 1) = ${contentDigest()})`.mapWith(Number),
    })
    .from(products)
    .where(sql`${products.status} = 'draft'`);
  return row;
}

/** Live integrity checks of stock and orders; each number should be 0. */
async function integrityCounts(db: Db) {
  const { rows } = await db.execute<Record<string, string | number>>(sql`select
    (select count(*) from ${inventoryBalances} b where b.reserved <> coalesce((select sum(r.quantity) from ${stockReservations} r where r.variant_id = b.variant_id and r.status = 'active'), 0)) as reserved_mismatch,
    (select count(*) from ${inventoryBalances} b where b.on_hand <> coalesce((select sum(m.quantity_delta) from ${stockMovements} m where m.variant_id = b.variant_id), 0)) as ledger_mismatch,
    (select count(*) from ${stockReservations} r join ${orders} o on o.id = r.order_id
      where r.status = 'active' and (o.order_status in ('cancelled', 'verification_expired', 'closed') or o.fulfilment_status not in ('unfulfilled', 'packed'))) as stray_holds,
    (select count(*) from ${orders} o where o.order_status = 'confirmed' and o.fulfilment_status in ('unfulfilled', 'packed')
      and not exists (select 1 from ${stockReservations} r where r.order_id = o.id and r.status = 'active')) as unheld_orders,
    (select count(*) from ${orders} o where o.order_status = 'pending_verification' and o.verification_expires_at <= now()) as overdue,
    (select count(*) from ${guestCheckoutSubmissions}) as guest_submissions,
    (select count(*) from ${products} p where p.status = 'published') as published`);
  const r = rows[0];
  return {
    reservedMismatch: n(r.reserved_mismatch),
    ledgerMismatch: n(r.ledger_mismatch),
    strayHolds: n(r.stray_holds),
    unheldOrders: n(r.unheld_orders),
    overdue: n(r.overdue),
    guestSubmissions: n(r.guest_submissions),
    published: n(r.published),
  };
}

const STATUS_BY_POLICY: Record<PolicyStatus, CheckStatus> = { empty: "incomplete", drafted: "incomplete", reviewed: "founder_approval" };
const POLICY_EVIDENCE: Record<PolicyStatus, string> = {
  empty: "No draft yet.",
  drafted: "Drafted, not yet marked reviewed.",
  reviewed: "Drafted in both languages and marked reviewed by you. Not approved for publication and not published: no publication exists in this version.",
};

/** The whole overview for the Owner. */
export async function launchReadiness(db: Db, principal: Principal): Promise<LaunchReadiness> {
  assertPermission(principal, "launch:read");
  const [c, integrity, zones, policyRows] = [await catalogueCounts(db), await integrityCounts(db), await db.select().from(deliveryZones), await db.select().from(policyDrafts)];
  const policyStatus = (kind: PolicyKind): PolicyStatus => {
    const row = policyRows.find((p) => p.kind === kind);
    return !row ? "empty" : row.reviewedAt ? "reviewed" : row.bodyEn || row.bodyBn ? "drafted" : "empty";
  };
  const activeZones = DELIVERY_ZONES.filter((code) => zones.some((z) => z.code === code && z.active));
  const facts: LaunchFacts = {
    policies: { delivery: policyStatus("delivery"), returns: policyStatus("returns"), privacy: policyStatus("privacy"), checkout_notices: policyStatus("checkout_notices") },
    deliveryZonesConfigured: activeZones.length === DELIVERY_ZONES.length,
    reviewedProducts: c.reviewed,
  };

  const drafts = c.drafts;
  const productRow = (id: string, label: string, missing: number, source: string, pending = false): ReadinessCheck => ({
    id,
    label,
    status: drafts === 0 || missing > 0 ? "incomplete" : "ready",
    evidence: drafts === 0 ? "No draft products yet." : missing === 0 ? `All ${plural(drafts, "draft product")}.` : `${missing} of ${plural(drafts, "draft product")} still missing this.`,
    next: missing > 0 || drafts === 0 ? (pending ? "Complete it, or ask the founder whether this proposed requirement applies." : "Complete it on each product page.") : null,
    source,
    href: "/office/catalogue-preparation",
  });

  // Without an approved rule nothing can be published through the application; a published product means a
  // direct database change, which must be investigated.
  const unexpectedlyPublished = APPROVED_PUBLICATION_RULE === null && integrity.published > 0;
  const catalogue: ReadinessCheck[] = [
    productRow("names", "Product name in English and Bangla", c.name, "S-1"),
    productRow("descriptions", "Description in English and Bangla", c.description, "S-1"),
    productRow("measurements", "Measurements in cm for every size on sale", c.measurements, "I-6, S-6 (proposed)", true),
    productRow("fabric", "Fabric statement in both languages, confirmed by you", c.fabric, "I-6, S-6, S-11", true),
    productRow("care", "Care instructions in both languages", c.care, "S-6 (proposed)", true),
    productRow("variants", "At least one active SKU with a valid price", c.variant, "I-9, I-10"),
    productRow("stock", "Units available to sell", c.noStock, "I-2"),
    productRow("photos", "At least one photo", c.photo, "engineering (I-5 open)"),
    productRow("alt", "Every photo described in both languages", c.alt, "engineering (S-13)"),
    productRow("categories", "Category chosen", c.category, "engineering"),
    {
      id: "reviews",
      label: "Internal review of the current content",
      status: drafts > 0 && c.reviewed === drafts ? "ready" : "incomplete",
      evidence: drafts === 0 ? "No draft products yet." : `${c.reviewed} of ${plural(drafts, "draft product")} have a current review.`,
      next: c.reviewed < drafts ? "Review products in Product reviews. A later change to a product makes its review outdated." : null,
      source: "engineering default",
      href: "/office/product-reviews",
    },
    {
      id: "publication",
      label: "Publication eligibility",
      status: unexpectedlyPublished ? "incomplete" : "founder_approval",
      evidence: unexpectedlyPublished
        ? `${plural(integrity.published, "product")} marked published although no publication rule is approved: this was not done through the application.`
        : "No publication rule is approved (I-6 is proposed). The publication mechanics are built and tested, but the publish operation refuses and nothing calls it. A review does not make a product public.",
      next: unexpectedlyPublished ? "Investigate the database change; take a backup first." : "Founder decides what a product needs before it is published.",
      source: "I-6",
    },
  ];

  const integrityProblems = integrity.reservedMismatch + integrity.ledgerMismatch + integrity.strayHolds + integrity.unheldOrders;
  const commerce: ReadinessCheck[] = [
    {
      id: "delivery_zones",
      label: "Delivery charges for Dhaka City and Outside Dhaka",
      status: facts.deliveryZonesConfigured ? "ready" : "incomplete",
      evidence: facts.deliveryZonesConfigured ? "Both zones have an active charge you set." : `${activeZones.length} of ${DELIVERY_ZONES.length} zones have an active charge.`,
      next: facts.deliveryZonesConfigured ? null : "Set the real charges in Delivery charges.",
      source: "O-8, rule I",
      href: "/office/settings/delivery",
    },
    {
      id: "integrity",
      label: "Stock, reservation and order integrity (live check)",
      status: integrityProblems === 0 ? "ready" : "incomplete",
      evidence:
        integrityProblems === 0
          ? "Every balance matches its ledger and its active holds; no cancelled, expired or dispatched order holds stock; every confirmed, undispatched order holds its stock."
          : `Found: ${integrity.ledgerMismatch} ledger mismatches, ${integrity.reservedMismatch} reservation mismatches, ${integrity.strayHolds} stray holds, ${integrity.unheldOrders} confirmed orders without holds.`,
      next: integrityProblems === 0 ? null : "Stop and investigate before taking more orders; take a backup first.",
      source: "I-2, I-4, O-4",
    },
    {
      id: "expiry",
      label: "24-hour verification expiry",
      status: "not_verified",
      evidence: `Built and tested: every order and stock operation releases overdue holds first, and npm run orders:expire-verification is the batch. No scheduler runs it on a server. ${integrity.overdue ? `${plural(integrity.overdue, "order")} past the deadline now.` : "No order is past its deadline now."}`,
      next: "When hosting is chosen, schedule the batch there and test it.",
      source: "O-12, rule D",
    },
    { id: "cod", label: "Cash on delivery: expected, collected, settled", status: "ready", evidence: "Built and tested for Owner-recorded collection and settlement. Courier fees and statement reconciliation are not recorded (OF-8).", next: null, source: "OF-3, rule J", href: "/office/reports" },
    { id: "returns", label: "Returns, refunds and RTO with inspection", status: "ready", evidence: "Built and tested. Exchange execution (replacement charge, price difference) is not decided.", next: null, source: "O-13, O-14, rules E to G, M" },
    {
      id: "tracking",
      label: "Private order tracking",
      status: "not_verified",
      evidence: "Built and tested: random links, digest only, masked view, revocation, per-link and global limits. A per-client limit needs a trusted proxy.",
      next: "Choose hosting; then add and test a per-client limit.",
      source: "S-9, S-15, G-4",
    },
    {
      id: "guest_checkout",
      label: "Guest checkout service",
      status: "not_verified",
      evidence: `Built and tested against PostgreSQL (atomic order, reservation, tracking link, anonymous idempotency). No public endpoint calls it; ${plural(integrity.guestSubmissions, "guest submission")} recorded.`,
      next: "A later gate adds the public endpoint with abuse protection, once the policies are published.",
      source: "S-3, S-4, O-3",
    },
    {
      id: "checkout_disabled",
      label: "Public checkout is disabled until approval",
      status: "ready",
      evidence: `Disabled. The launch gate refuses with ${plural(publicCheckoutGate(facts).blockers.length, "open reason")} (below). No switch opens it.`,
      next: null,
      source: "S-17, G-7",
    },
  ];

  const policies: ReadinessCheck[] = POLICY_KINDS.map((kind) => ({
    id: `policy_${kind}`,
    label: POLICY_TITLES[kind],
    status: STATUS_BY_POLICY[policyStatus(kind)],
    evidence: POLICY_EVIDENCE[policyStatus(kind)],
    next: policyStatus(kind) === "reviewed" ? "Founder approval of the final text, then publication (a later gate)." : "Write it in both languages; have it checked where legal review is needed.",
    source: kind === "checkout_notices" ? "S-8, S-17" : "S-17, G-7",
    href: `/office/policies#${kind}`,
  }));
  policies.push({ id: "policy_publication", label: "Publication of the policies", status: "founder_approval", evidence: "Not published. This version has no publication step.", next: "Founder approves the text; a later gate publishes it.", source: "S-17, G-7" });

  const operations: ReadinessCheck[] = [
    { id: "hosting", label: "Production hosting", status: "founder_approval", evidence: "Not chosen. Nothing is deployed.", next: "Founder chooses within C-1 to C-3; then verify G-8.", source: "Open decision 1, G-8" },
    { id: "durability", label: "Database and photo storage durability", status: "not_verified", evidence: "Local development database and a local photo folder only.", next: "Follows the hosting decision (and decision 14 for photos).", source: "ADR-0006, I-5" },
    { id: "backups", label: "Backup schedule and off-device copy", status: "founder_approval", evidence: "Encrypted local backup tools exist for the database and photos; no schedule, retention or off-device copy.", next: "Founder approves RPO and RTO and chooses the off-device place.", source: "K-4, K-5, K-8, decisions 6 and 15" },
    { id: "rpo_rto", label: "Recovery point and time objectives (RPO, RTO)", status: "founder_approval", evidence: "Not approved.", next: "Founder approves them.", source: "K-9" },
    { id: "restore", label: "Verified restore", status: "not_verified", evidence: "Database and photo restore drills pass on fictional data on this computer. No restore of real data against an approved RTO.", next: "After RPO and RTO: a timed drill of a real backup into a fresh place.", source: "K-6, G-6" },
    { id: "recovery", label: "Production account recovery", status: "incomplete", evidence: "Only a local command-line password reset exists; no lost-device recovery path, no 2FA.", next: "Founder decides the recovery method (OF-5).", source: "OF-5, decision 3" },
    { id: "rate_limits", label: "Rate limiting", status: "not_verified", evidence: "Sign-in, API (per user) and tracking (per link, global) limits exist and are tested. No per-client limit for anonymous traffic.", next: "Needs a trusted proxy from the hosting decision.", source: "API-11, S-15" },
    { id: "usability", label: "Usability test with real people", status: "not_verified", evidence: "Automated accessibility and browser tests only. No test with people yet.", next: "Five informal testers, one first-time online buyer, on a mid-range Android phone.", source: "G-9" },
    { id: "design", label: "Final visual design", status: "founder_approval", evidence: "Two prototype concepts in the storefront preview; none approved.", next: "Founder chooses or asks for changes.", source: "BR-6, decision 4", href: "/office/storefront-preview" },
    { id: "licences", label: "Licences and portability", status: "not_verified", evidence: "A licence inventory and a rebranded-installation rehearsal exist; no licence review.", next: "Review the licence list before any handoff.", source: "RU-5, G-14" },
  ];

  return {
    drafts,
    gate: publicCheckoutGate(facts),
    sections: [
      { id: "catalogue", title: "Catalogue", checks: catalogue },
      { id: "commerce", title: "Commerce", checks: commerce },
      { id: "policies", title: "Policies", checks: policies },
      { id: "operations", title: "Operations", checks: operations },
    ],
  };
}
