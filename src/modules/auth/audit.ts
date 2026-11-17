import "server-only";
import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import { type Db, pgErrorCode } from "@/db/database";
import { authEvents } from "@/db/schema";

// Security audit of authentication (migration 0017, table auth_events). Called only from the Better Auth hooks in
// auth.ts, with identities Better Auth verified (a new session, the session of an authenticated request, the session
// row being deleted); nothing a request body says about a user, role or actor is used. Access changes are recorded
// by a database trigger, the local Owner commands write their own rows in their transactions.
//
// Failure policy: a sign-in that cannot be recorded is refused and its new session deleted (no unaudited session
// stays usable). An action that reduces access (sign-out, revocation) always takes effect: if its row cannot be
// written, the failure is logged (event name, error name and SQL state only) and the action stands. A failed sign-in
// or a password change that cannot be recorded is logged the same way and its answer is not changed, so the audit
// never becomes an oracle about accounts.

export type AuthTransport = "browser" | "native";
export type SessionEndReason = "sign_out" | "revoked" | "revoked_all" | "revoked_others" | "password_changed" | "expired" | "audit_unavailable" | "other";

const MAX_EMAIL = 254;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * A keyed digest of the address a failed sign-in tried: equal attempts on one address share it, but without the
 * installation's secret it cannot be turned back into the address or tested against guesses. Changing the secret
 * changes every digest. Null for anything that is not a plausible address.
 */
export function subjectDigest(secret: string, email: unknown): string | null {
  if (typeof email !== "string") return null;
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > MAX_EMAIL) return null;
  return createHmac("sha256", secret).update(`auth-event-subject:${normalized}`).digest("hex");
}

/** A failure to write an audit row: names only, never the error message (it can hold query parameters). */
export function logAuditFailure(auditEvent: string, error: unknown): void {
  console.error(
    JSON.stringify({ level: "error", event: "auth_audit_failed", auditEvent, errorName: error instanceof Error ? error.name : typeof error, sqlState: pgErrorCode(error) ?? null }),
  );
}

export async function recordSignIn(db: Db, input: { userId: string; sessionId: string; transport: AuthTransport }): Promise<void> {
  await db
    .insert(authEvents)
    .values({ event: "sign_in", actorType: "user", actorUserId: input.userId, subjectUserId: input.userId, sessionId: input.sessionId, transport: input.transport, detail: {} });
}

export async function recordFailedSignIn(db: Db, input: { digest: string | null; transport: AuthTransport; status: number; code: unknown }): Promise<void> {
  const code = typeof input.code === "string" && CODE.test(input.code) ? input.code : "OTHER";
  const status = Number.isSafeInteger(input.status) && input.status >= 100 && input.status <= 599 ? input.status : 0;
  await db.insert(authEvents).values({ event: "sign_in_failed", actorType: "anonymous", subjectDigest: input.digest, transport: input.transport, detail: { status, code } });
}

/**
 * One row per ended session, however many requests end it at the same time (two concurrent "sign out everywhere"
 * requests both see the same sessions): the unique index on session_id for session_ended makes the second a no-op.
 */
export async function recordSessionEnded(
  db: Db,
  input: { sessionId: string; userId: string; reason: SessionEndReason; actorUserId: string | null; transport: AuthTransport | null },
): Promise<void> {
  await db.execute(sql`
    insert into ${authEvents} (event, actor_type, actor_user_id, subject_user_id, session_id, transport, detail)
    values ('session_ended', ${input.actorUserId ? "user" : "system"}, ${input.actorUserId}, ${input.userId}, ${input.sessionId}, ${input.transport}, ${JSON.stringify({ reason: input.reason })}::jsonb)
    on conflict (session_id) where event = 'session_ended' do nothing`);
}

export async function recordPasswordChanged(db: Db, input: { userId: string; transport: AuthTransport; revokedOtherSessions: boolean }): Promise<void> {
  await db.insert(authEvents).values({
    event: "password_changed",
    actorType: "user",
    actorUserId: input.userId,
    subjectUserId: input.userId,
    transport: input.transport,
    detail: { revokedOtherSessions: input.revokedOtherSessions },
  });
}

const REASON_BY_PATH: Record<string, SessionEndReason> = {
  "/sign-out": "sign_out",
  "/revoke-session": "revoked",
  "/revoke-sessions": "revoked_all",
  "/revoke-other-sessions": "revoked_others",
  "/change-password": "password_changed",
  "/get-session": "expired",
  "/sign-in/email": "audit_unavailable",
};

/** Why a session row was deleted, from the endpoint that deleted it (null outside an endpoint). */
export function sessionEndReason(path: string | undefined): SessionEndReason {
  return (path !== undefined && Object.hasOwn(REASON_BY_PATH, path) ? REASON_BY_PATH[path] : undefined) ?? "other";
}
