import "server-only";
import type { Db } from "@/db/database";
import { issueUserActor, type UserActor } from "../actor";
import { DomainError } from "../domain-error";
import { findActiveRole } from "./access";
import type { Auth } from "./auth";
import { roleHasPermission, type Permission, type Role } from "./permissions";

/** An authenticated user with active access, verified on the server for this request. */
export type Principal = Readonly<{ userId: string; role: Role }>;

// Principals created by getPrincipal. A look-alike object (for example parsed from a request) is refused.
const verifiedPrincipals = new WeakSet<Principal>();

/**
 * Verifies the request's session cookie against the session table (Better Auth, no cookie cache) and then
 * reads the user's role and disabled state from PostgreSQL. Returns null for a missing, invalid, expired
 * or revoked session, and for a user without active access. Nothing a client sends besides the signed
 * session cookie is used: no role, user id or actor field.
 */
export async function getPrincipal(auth: Auth, db: Db, headers: Headers): Promise<Principal | null> {
  const session = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
  if (!session) return null;
  const role = await findActiveRole(db, session.user.id);
  if (!role) return null;
  const principal: Principal = Object.freeze({ userId: session.user.id, role });
  verifiedPrincipals.add(principal);
  return principal;
}

export async function requirePrincipal(auth: Auth, db: Db, headers: Headers): Promise<Principal> {
  const principal = await getPrincipal(auth, db, headers);
  if (!principal) throw new DomainError("UNAUTHENTICATED", "Sign in to continue.");
  return principal;
}

/** Requires a verified principal that holds `permission`. */
export async function requirePermission(auth: Auth, db: Db, headers: Headers, permission: Permission): Promise<Principal> {
  const principal = await requirePrincipal(auth, db, headers);
  if (!roleHasPermission(principal.role, permission)) {
    throw new DomainError("FORBIDDEN", "You do not have permission to do this.");
  }
  return principal;
}

/** The audit actor for a verified principal: its immutable user id, never a name or email. */
export function actorFor(principal: Principal): UserActor {
  if (!verifiedPrincipals.has(principal)) throw new Error("actorFor needs a principal from getPrincipal.");
  return issueUserActor(principal.userId);
}
