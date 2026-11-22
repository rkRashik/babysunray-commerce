// Named permissions and the roles that hold them (ADR-0013). The Owner holds every permission. Staff roles hold a subset
// chosen by least privilege: a role label grants nothing by itself, only the permissions listed for it here, checked on
// the server for every page, Server Action, API call and operation.
export const PERMISSIONS = [
  "catalog:read",
  "catalog:write",
  "stock:read",
  "stock:receive",
  // Starting a physical stock count and entering counted quantities. Applying a count changes stock and needs stock:adjust.
  "stock:count",
  "stock:adjust",
  "orders:read",
  // Everyday order work: assisted orders, verification, packing, dispatch, delivery, RTO, cancellation of unpaid orders,
  // return requests and tracking links. Never money: that needs payments:record or payments:verify.
  "orders:write",
  // Deciding a return or exchange after inspection (approving a return approves its refund).
  "returns:decide",
  // Recording money: COD collection, settlement and courier deductions, RTO charges, courier statement checks, refunds.
  "payments:record",
  // Confirming that a manual advance payment (bKash, Nagad, bank transfer) really arrived, rejecting a reference, undoing a
  // mistaken verification, and cancelling an order that holds verified money.
  "payments:verify",
  "settings:write",
  // Dashboard, reports and printed summaries (no customer contact details).
  "reports:read",
  // Exports may hold customer personal data (requirement D-6): a permission of its own, audited per request.
  "exports:create",
  // The private storefront preview (draft products, cart and checkout simulation). Never granted to anonymous
  // visitors: a public storefront would need its own, published-only reads.
  "storefront:preview",
  // Recording an internal product review (Gate H.26): separate from editing, so a role can edit without reviewing. A
  // review publishes nothing.
  "catalog:review",
  // Publishing and withdrawing products (Gate H.32).
  "catalog:publish",
  // Private customer-policy drafts (S-17): reading may show unpublished wording; writing never publishes.
  "policies:read",
  "policies:write",
  // Publishing a reviewed policy to customers, or withdrawing it: the founder's approval of that exact wording (ADR-0011).
  "policies:publish",
  // The launch-readiness overview (what still blocks a public shop).
  "launch:read",
  // Starting or ending a founder acceptance pass for the real shop (staging database only; ADR-0011).
  "acceptance:run",
  // Staff & Access: inviting staff, changing their role, disabling them and ending their sessions.
  "users:manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Every role, the Owner first. Staff roles can be given by the Owner; the Owner role never can (ADR-0013). */
export const ROLES = ["owner", "manager", "orders", "catalogue", "inventory"] as const;
export type Role = (typeof ROLES)[number];
export const STAFF_ROLES = ["manager", "orders", "catalogue", "inventory"] as const satisfies readonly Role[];
export type StaffRole = (typeof STAFF_ROLES)[number];
export const isStaffRole = (value: unknown): value is StaffRole => typeof value === "string" && (STAFF_ROLES as readonly string[]).includes(value);

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  // Runs the store day to day: catalogue, stock (including adjustments and applying counts), everyday orders, reports.
  // No money recording or verification, publishing, policies, settings, exports, staff or launch work.
  manager: ["catalog:read", "catalog:write", "catalog:review", "stock:read", "stock:receive", "stock:count", "stock:adjust", "orders:read", "orders:write", "reports:read", "storefront:preview"],
  // Customer orders from verification to delivery. Reads products and stock to answer customers; changes neither.
  orders: ["catalog:read", "stock:read", "orders:read", "orders:write"],
  // Draft products, photos, descriptions, categories, size charts and variants. Cannot review or publish.
  catalogue: ["catalog:read", "catalog:write", "stock:read", "storefront:preview"],
  // Receiving stock and counting it. Applying a count or adjusting stock waits for a Manager or the Owner.
  inventory: ["catalog:read", "stock:read", "stock:receive", "stock:count"],
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  // Own keys only, so a value such as "__proto__" read from storage never matches an inherited property.
  return Object.hasOwn(ROLE_PERMISSIONS, role) && ROLE_PERMISSIONS[role].includes(permission);
}

/** What the Staff & Access page says about each role, in plain words (never raw permission names). */
export const ROLE_INFO: Record<Role, { label: string; summary: string; can: string[]; cannot: string[] }> = {
  owner: {
    label: "Owner",
    summary: "The founder. Full control of the store, its money and its staff.",
    can: ["Everything in Admin", "Manage staff and their access", "Verify payments and record money", "Store settings, payment methods, policies and publishing"],
    cannot: [],
  },
  manager: {
    label: "Store Manager",
    summary: "Runs the store day to day.",
    can: ["Products, photos, variants and product reviews", "Receive stock, count it and apply counts or adjustments", "Handle orders from verification to delivery", "See the dashboard and reports"],
    cannot: ["Record or verify money, refunds or return decisions", "Publish products or policies", "Change store settings or payment methods", "Manage staff, exports or launch work"],
  },
  orders: {
    label: "Orders Staff",
    summary: "Handles customer orders.",
    can: ["See orders and the customer details needed to deliver them", "Create assisted orders, verify, pack, dispatch and record delivery", "Cancel unpaid orders and record return requests", "Look up products and stock"],
    cannot: ["Mark money received, verify payments or record refunds", "Change products, prices or stock", "Change settings or manage staff"],
  },
  catalogue: {
    label: "Catalogue Staff",
    summary: "Prepares product information.",
    can: ["Create and edit draft products, variants and size charts", "Upload and arrange product photos", "Manage categories", "Check publication readiness and the storefront preview"],
    cannot: ["Review or publish products", "See orders or customers", "Change stock, settings or staff"],
  },
  inventory: {
    label: "Inventory Staff",
    summary: "Handles physical stock.",
    can: ["Look up products and stock levels", "Receive stock", "Start stock counts and enter counted quantities"],
    cannot: ["Apply a count or adjust stock (a Manager or the Owner does)", "See orders or customers", "Change products, settings or staff"],
  },
};
