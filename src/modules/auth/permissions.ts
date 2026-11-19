// Named permissions and the roles that hold them. The only role today is the owner (requirement OF-7);
// a later role is added here with its own subset, and every check keeps working unchanged.
export const PERMISSIONS = [
  "catalog:read",
  "catalog:write",
  "stock:read",
  "stock:receive",
  "stock:adjust",
  "orders:read",
  "orders:write",
  "payments:record",
  "settings:write",
  // Dashboard, reports and printed summaries (no customer contact details).
  "reports:read",
  // Exports may hold customer personal data (requirement D-6): a permission of its own, audited per request.
  "exports:create",
  // The private storefront preview (draft products, cart and checkout simulation). Never granted to anonymous
  // visitors: a public storefront would need its own, published-only reads.
  "storefront:preview",
  // Recording an internal product review (Gate H.26): separate from editing, so a later role can edit without
  // reviewing. A review publishes nothing.
  "catalog:review",
  // Publishing and withdrawing products (Gate H.32). Holding it publishes nothing while no publication rule
  // (I-6) is approved: the operation refuses (src/modules/catalogue/publication.ts).
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
  "users:manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type Role = "owner";

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  // Own keys only, so a value such as "__proto__" read from storage never matches an inherited property.
  return Object.hasOwn(ROLE_PERMISSIONS, role) && ROLE_PERMISSIONS[role].includes(permission);
}
