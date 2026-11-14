import "server-only";
import type { Db } from "@/db/database";
import type { UserActor } from "../actor";
import { DomainError } from "../domain-error";
import { findActiveRole } from "./access";
import type { Auth } from "./auth";
import { roleHasPermission, type Permission, type Role } from "./permissions";

/** An authenticated user with active access, verified on the server for this request. */
export type Principal = Readonly<{ userId: string; role: Role }>;

// Principals created here after Better Auth verified a session, and the user actors issued for them.
// Module-private: no other code can add to them, so a look-alike object (for example parsed from a
// request body) is never accepted as either.
const verifiedPrincipals = new WeakSet<Principal>();
const issuedUserActors = new WeakSet<object>();

// A Bearer credential is Better Auth's signed session token: base64url token, ".", base64 HMAC
// (sometimes percent-encoded). Anything else is refused before Better Auth sees it.
const BEARER = /^Bearer ([A-Za-z0-9._~+/=%-]{1,512})$/;

/**
 * Browser transport: verifies only the session cookie. An Authorization header on the same request is
 * dropped, so a Bearer token never authenticates browser-side server code.
 */
export function getPrincipal(auth: Auth, db: Db, headers: Headers): Promise<Principal | null> {
  const cookie = headers.get("cookie");
  return verify(auth, db, cookie ? new Headers({ cookie }) : null);
}

/**
 * API transport (/api/v1): verifies only `Authorization: Bearer <signed session token>`. Cookies on the
 * same request are dropped, so a browser session never authenticates an API call (no CSRF exposure).
 */
export function getBearerPrincipal(auth: Auth, db: Db, headers: Headers): Promise<Principal | null> {
  const authorization = headers.get("authorization");
  return verify(auth, db, authorization && BEARER.test(authorization) ? new Headers({ authorization }) : null);
}

// Better Auth checks the credential against the session table (no cookie cache); then the user's role
// and disabled state are read from PostgreSQL. Null for a missing, invalid, expired or revoked session,
// and for a user without active access. No role, user id or actor field from the client is used.
async function verify(auth: Auth, db: Db, credential: Headers | null): Promise<Principal | null> {
  if (!credential) return null;
  const session = await auth.api.getSession({ headers: credential, query: { disableCookieCache: true } });
  if (!session) return null;
  const role = await findActiveRole(db, session.user.id);
  if (!role) return null;
  const principal: Principal = Object.freeze({ userId: session.user.id, role });
  verifiedPrincipals.add(principal);
  return principal;
}

/** UNAUTHENTICATED without a principal, FORBIDDEN when its role lacks `permission`. */
export function assertPermission(principal: Principal | null, permission: Permission): Principal {
  if (!principal || !verifiedPrincipals.has(principal)) throw new DomainError("UNAUTHENTICATED", "Sign in to continue.");
  if (!roleHasPermission(principal.role, permission)) {
    throw new DomainError("FORBIDDEN", "You do not have permission to do this.");
  }
  return principal;
}

export async function requirePrincipal(auth: Auth, db: Db, headers: Headers): Promise<Principal> {
  const principal = await getPrincipal(auth, db, headers);
  if (!principal) throw new DomainError("UNAUTHENTICATED", "Sign in to continue.");
  return principal;
}

/** Browser transport: requires a verified principal that holds `permission`. */
export async function requirePermission(auth: Auth, db: Db, headers: Headers, permission: Permission): Promise<Principal> {
  return assertPermission(await getPrincipal(auth, db, headers), permission);
}

/** The audit actor for a verified principal: its immutable user id, never a name or email. */
export function actorFor(principal: Principal): UserActor {
  if (!verifiedPrincipals.has(principal)) throw new Error("actorFor needs a verified principal.");
  const actor: UserActor = Object.freeze({ type: "user", ref: principal.userId });
  issuedUserActors.add(actor);
  return actor;
}

/** True only for an actor returned by `actorFor`. Used by validateActor. */
export function isIssuedUserActor(actor: unknown): boolean {
  return typeof actor === "object" && actor !== null && issuedUserActors.has(actor);
}
