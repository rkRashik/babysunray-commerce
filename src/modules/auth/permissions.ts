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
