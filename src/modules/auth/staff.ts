import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { sql } from "drizzle-orm";
import { type Db, pgErrorCode } from "@/db/database";
import { DomainError, invalidInput } from "../domain-error";
import { type EmailSender, simpleMessage } from "../email/service";
import { type Once, runOnce } from "../idempotency/service";
import { consumePublicLimit } from "../rate-limit/service";
import { normalizeEmail, validateOwnerInput, validatePassword } from "./owner-input";
import { isStaffRole, ROLE_INFO, type Role, type StaffRole } from "./permissions";
import { actorFor, assertPermission, type Principal } from "./principal";

// Staff & access (ADR-0013). The Owner (users:manage) invites staff by email with a staff role, changes their role,
// disables or re-enables them, ends their sessions and sends them a link to set a new password. Staff never get the
// Owner role, and nothing here changes an Owner's own access, so the Owner can never be locked out from this page.
//
// Links: 32 random bytes (base64url), shown or emailed once; only the SHA-256 digest is stored (staff_invitations). The
// link carries the token in the URL fragment (/admin/invite#t=…), which browsers never send to a server; the page posts
// it in a same-origin request body. A link works once, for 72 hours, and at most one is open per address (a new one
// revokes the old one). Redeeming is rate limited storewide. Every change is recorded in auth_events with the Owner as
// the actor (ids and roles only, never an email address); access changes are also recorded by the user_access trigger.

export const LINK_HOURS = 72;
const REDEEMS_PER_MINUTE = 20;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const digest = (token: string) => createHash("sha256").update(token).digest("hex");

export type StaffLinkResult = { invitationId: string; token: string | null; emailed: boolean };
export type StaffLinkDeps = { send: EmailSender | null; baseUrl: string; storeName: string };

const NOT_HERE = () => new DomainError("FORBIDDEN", "The Owner's own access cannot be changed here.");
const NOT_FOUND = () => new DomainError("INVALID_INPUT", "That staff account was not found.");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function email(raw: unknown): string {
  try {
    return normalizeEmail(String(raw ?? ""));
  } catch {
    throw invalidInput("email", "must be an email address");
  }
}

function id(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !UUID.test(raw)) throw invalidInput(field, "is not valid");
  return raw.toLowerCase();
}

async function audit(tx: Db, event: string, actorUserId: string, subjectUserId: string | null, detail: Record<string, unknown>) {
  await tx.execute(
    sql`insert into auth_events (event, actor_type, actor_user_id, subject_user_id, transport, detail) values (${event}, 'user', ${actorUserId}, ${subjectUserId}, 'browser', ${JSON.stringify(detail)}::jsonb)`,
  );
}

/** Locks the target's access row; refuses an unknown user and any Owner. */
async function lockStaff(tx: Db, userId: string): Promise<{ role: StaffRole; disabled: boolean; email: string }> {
  const { rows } = await tx.execute<{ role: Role; disabled: boolean; email: string }>(
    sql`select a.role, a.disabled_at is not null as disabled, u.email from user_access a join auth_users u on u.id = a.user_id where a.user_id = ${userId} for update of a`,
  );
  const row = rows[0];
  if (!row) throw NOT_FOUND();
  if (!isStaffRole(row.role)) throw NOT_HERE();
  return { role: row.role, disabled: row.disabled, email: row.email };
}

/** Revokes any open link for the address, then stores a new one. Returns the link's id and token (the token only here). */
async function issueLink(tx: Db, input: { kind: "invite" | "password"; email: string; role: StaffRole | null; userId: string | null; createdBy: string }) {
  await tx.execute(sql`update staff_invitations set revoked_at = now() where email = ${input.email} and accepted_at is null and revoked_at is null`);
  const token = randomBytes(32).toString("base64url");
  const { rows } = await tx.execute<{ id: string }>(
    sql`insert into staff_invitations (kind, email, role, user_id, token_sha256, expires_at, created_by_user_id)
        values (${input.kind}, ${input.email}, ${input.role}, ${input.userId}, ${digest(token)}, now() + make_interval(hours => ${LINK_HOURS}), ${input.createdBy}) returning id`,
  );
  return { invitationId: rows[0].id, token };
}

/**
 * Emails a freshly created link when email is set up. Without email, or when sending fails, the token is handed back so
 * the Owner can pass the link on privately; it is never shown twice (a replay answers token null).
 */
async function deliver(result: Once<{ invitationId: string }>, token: string | null, to: string, kind: "invite" | "password", role: StaffRole | null, deps: StaffLinkDeps): Promise<StaffLinkResult> {
  if (result.replayed || !token) return { invitationId: result.value.invitationId, token: null, emailed: false };
  if (deps.send) {
    const link = `${deps.baseUrl}/admin/invite#t=${token}`;
    const lines =
      kind === "invite"
        ? [`You are invited to work in ${deps.storeName} Admin as ${ROLE_INFO[role!].label}.`, `The link works once, for ${LINK_HOURS} hours. You choose your own password.`, `${deps.storeName} অ্যাডমিনে কাজ করার আমন্ত্রণ। লিংকটি একবারই, ${LINK_HOURS} ঘণ্টা কাজ করবে।`]
        : [`Choose a new password for your ${deps.storeName} Admin account.`, `The link works once, for ${LINK_HOURS} hours. Your old sessions end when you use it.`, `আপনার অ্যাডমিন অ্যাকাউন্টের নতুন পাসওয়ার্ড দিন। লিংকটি একবারই, ${LINK_HOURS} ঘণ্টা কাজ করবে।`];
    try {
      await deps.send(simpleMessage({ to, subject: kind === "invite" ? `${deps.storeName}: your Admin invitation` : `${deps.storeName}: set your Admin password`, lines: [...lines, "If you did not expect this, ignore this email."], link: { url: link, label: kind === "invite" ? "Accept the invitation" : "Set a new password" } }));
      return { invitationId: result.value.invitationId, token: null, emailed: true };
    } catch {
      // EmailFailed is logged by the sender (status only); the Owner gets the link to pass on instead.
    }
  }
  return { invitationId: result.value.invitationId, token, emailed: false };
}

/** Invites an address with a staff role. Refused for an address that already has an Admin account (Owner or staff). */
export async function inviteStaffOnce(db: Db, principal: Principal, key: string, input: { email: unknown; role: unknown }, deps: StaffLinkDeps): Promise<StaffLinkResult> {
  const user = assertPermission(principal, "users:manage");
  const address = email(input.email);
  if (!isStaffRole(input.role)) throw invalidInput("role", "must be one of the staff roles");
  const role = input.role;
  // Assigned inside the operation; the cast keeps TypeScript from narrowing it to null.
  let token = null as string | null;
  const result = await runOnce(
    db,
    { userId: user.userId, operation: "staff.invite", key, request: { email: address, role } },
    async (tx) => {
      const { rows } = await tx.execute<{ n: number }>(sql`select count(*)::int as n from auth_users where email = ${address}`);
      if (rows[0].n > 0) throw new DomainError("INVALID_INPUT", "An Admin account with this email already exists. Change its role or re-enable it instead.");
      const issued = await issueLink(tx, { kind: "invite", email: address, role, userId: null, createdBy: actorFor(user).ref });
      await audit(tx, "staff_invited", user.userId, null, { invitationId: issued.invitationId, role });
      token = issued.token;
      return { invitationId: issued.invitationId };
    },
    async (_tx, ref: { invitationId: string }) => ref,
  );
  return deliver(result, token, address, "invite", role, deps);
}

/** A link for an existing staff account to set a new password (staff have no recovery codes). */
export async function sendPasswordLinkOnce(db: Db, principal: Principal, key: string, input: { userId: unknown }, deps: StaffLinkDeps): Promise<StaffLinkResult> {
  const user = assertPermission(principal, "users:manage");
  const target = id(input.userId, "userId");
  // Assigned inside the operation; the cast keeps TypeScript from narrowing it to null.
  let token = null as string | null;
  let to = "" as string;
  const result = await runOnce(
    db,
    { userId: user.userId, operation: "staff.password-link", key, request: { userId: target } },
    async (tx) => {
      const staff = await lockStaff(tx, target);
      const issued = await issueLink(tx, { kind: "password", email: staff.email, role: null, userId: target, createdBy: actorFor(user).ref });
      await audit(tx, "staff_password_link", user.userId, target, { invitationId: issued.invitationId });
      token = issued.token;
      to = staff.email;
      return { invitationId: issued.invitationId };
    },
    async (_tx, ref: { invitationId: string }) => ref,
  );
  return deliver(result, token, to, "password", null, deps);
}

export async function revokeStaffLinkOnce(db: Db, principal: Principal, key: string, input: { invitationId: unknown }): Promise<Once<{ invitationId: string }>> {
  const user = assertPermission(principal, "users:manage");
  const invitationId = id(input.invitationId, "invitationId");
  return runOnce(
    db,
    { userId: user.userId, operation: "staff.link.revoke", key, request: { invitationId } },
    async (tx) => {
      const { rows } = await tx.execute<{ user_id: string | null }>(sql`update staff_invitations set revoked_at = now() where id = ${invitationId} and accepted_at is null and revoked_at is null returning user_id`);
      if (rows.length === 0) throw new DomainError("INVALID_TRANSITION", "This link is already used or revoked.");
      await audit(tx, "staff_invitation_revoked", user.userId, rows[0].user_id, { invitationId });
      return { invitationId };
    },
    async (_tx, ref: { invitationId: string }) => ref,
  );
}

/** Changes a staff member's role. `fromRole` is the role the Owner saw; a different current role is a conflict. */
export async function changeStaffRoleOnce(db: Db, principal: Principal, key: string, input: { userId: unknown; fromRole: unknown; toRole: unknown }): Promise<Once<{ userId: string }>> {
  const user = assertPermission(principal, "users:manage");
  const target = id(input.userId, "userId");
  if (!isStaffRole(input.toRole)) throw invalidInput("role", "must be one of the staff roles");
  if (!isStaffRole(input.fromRole)) throw invalidInput("fromRole", "is not valid");
  const request = { userId: target, fromRole: input.fromRole, toRole: input.toRole };
  return runOnce(
    db,
    { userId: user.userId, operation: "staff.role", key, request },
    async (tx) => {
      const staff = await lockStaff(tx, target);
      if (staff.role !== request.fromRole) throw new DomainError("VERSION_CONFLICT", "This person's role changed after you opened the page. Reload and try again.");
      if (staff.role !== request.toRole) {
        await tx.execute(sql`update user_access set updated_at = now(), role = ${request.toRole} where user_id = ${target}`);
        await audit(tx, "staff_role_changed", user.userId, target, { roleBefore: staff.role, roleAfter: request.toRole });
      }
      return { userId: target };
    },
    async (_tx, ref: { userId: string }) => ref,
  );
}

/** Disables (every session ends at once, by the user_access trigger) or re-enables a staff account. */
export async function setStaffEnabledOnce(db: Db, principal: Principal, key: string, input: { userId: unknown; enabled: boolean }): Promise<Once<{ userId: string }>> {
  const user = assertPermission(principal, "users:manage");
  const target = id(input.userId, "userId");
  const request = { userId: target, enabled: input.enabled === true };
  return runOnce(
    db,
    { userId: user.userId, operation: "staff.enabled", key, request },
    async (tx) => {
      const staff = await lockStaff(tx, target);
      if (staff.disabled === !request.enabled) return { userId: target };
      if (request.enabled) {
        await tx.execute(sql`update user_access set disabled_at = null, updated_at = now() where user_id = ${target}`);
      } else {
        // Any open set-password link for the account stops working too.
        await tx.execute(sql`update staff_invitations set revoked_at = now() where user_id = ${target} and accepted_at is null and revoked_at is null`);
        await tx.execute(sql`update user_access set disabled_at = now(), updated_at = now() where user_id = ${target}`);
      }
      await audit(tx, request.enabled ? "staff_enabled" : "staff_disabled", user.userId, target, { role: staff.role });
      return { userId: target };
    },
    async (_tx, ref: { userId: string }) => ref,
  );
}

/** Ends every session of a staff account (signed out everywhere); the account stays usable with its password. */
export async function revokeStaffSessionsOnce(db: Db, principal: Principal, key: string, input: { userId: unknown }): Promise<Once<{ userId: string; ended: number }>> {
  const user = assertPermission(principal, "users:manage");
  const target = id(input.userId, "userId");
  return runOnce(
    db,
    { userId: user.userId, operation: "staff.sessions.revoke", key, request: { userId: target } },
    async (tx) => {
      await lockStaff(tx, target);
      const { rows } = await tx.execute<{ id: string }>(sql`delete from auth_sessions where user_id = ${target} returning id`);
      await audit(tx, "staff_sessions_revoked", user.userId, target, { sessionsEnded: rows.length });
      return { userId: target, ended: rows.length };
    },
    async (_tx, ref: { userId: string; ended: number }) => ref,
  );
}

// --- Redeeming a link (no session: the token is the credential) ----------------------------------------------------

const BAD_LINK = () => new DomainError("INVALID_INPUT", "This link is not valid, was already used or has expired. Ask the Owner for a new one.");

async function redeemGuard(db: Db, token: unknown): Promise<string> {
  if (!(await consumePublicLimit(db, "staff-invite", REDEEMS_PER_MINUTE))) throw new DomainError("RATE_LIMITED", "Too many attempts. Wait a minute and try again.");
  if (typeof token !== "string" || !TOKEN.test(token)) throw BAD_LINK();
  return digest(token);
}

export type StaffLinkView = { kind: "invite" | "password"; email: string; roleLabel: string; expiresAt: Date };

/** What an open link is for (shown before the person chooses a password), or BAD_LINK. */
export async function staffLinkView(db: Db, token: unknown): Promise<StaffLinkView> {
  const hash = await redeemGuard(db, token);
  const { rows } = await db.execute<{ kind: "invite" | "password"; email: string; role: Role; expires_at: Date }>(sql`
    select i.kind, i.email, coalesce(i.role, a.role) as role, i.expires_at from staff_invitations i left join user_access a on a.user_id = i.user_id
     where i.token_sha256 = ${hash} and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()`);
  const row = rows[0];
  if (!row || !isStaffRole(row.role)) throw BAD_LINK();
  return { kind: row.kind, email: row.email, roleLabel: ROLE_INFO[row.role].label, expiresAt: new Date(row.expires_at) };
}

/**
 * Redeems a link once. An invitation creates the staff account (user, password credential, access with the invited role)
 * in one transaction; a password link sets the account's new password and ends all its sessions. The person then signs
 * in with their own email and password. The same answer for an unknown, used, revoked or expired link.
 */
export async function redeemStaffLink(db: Db, input: { token: unknown; name?: unknown; password: unknown }): Promise<{ kind: "invite" | "password" }> {
  const hash = await redeemGuard(db, input.token);
  const password = validatePassword(String(input.password ?? ""));
  const passwordHash = await hashPassword(password);
  try {
    return await db.transaction(async (tx) => {
      // Same lock order as the Owner set-up, so two redemptions (or a set-up) cannot create two accounts for one address.
      await tx.execute(sql`lock table auth_users, user_access in exclusive mode`);
      const { rows } = await tx.execute<{ id: string; kind: "invite" | "password"; email: string; role: StaffRole | null; user_id: string | null }>(
        sql`select id, kind, email, role, user_id from staff_invitations where token_sha256 = ${hash} and accepted_at is null and revoked_at is null and expires_at > now() for update`,
      );
      const link = rows[0];
      if (!link) throw BAD_LINK();
      if (link.kind === "invite") {
        const person = validateOwnerInput({ email: link.email, name: String(input.name ?? ""), password });
        const { rows: taken } = await tx.execute<{ n: number }>(sql`select count(*)::int as n from auth_users where email = ${link.email}`);
        if (taken[0].n > 0) throw BAD_LINK();
        const { rows: created } = await tx.execute<{ id: string }>(sql`insert into auth_users (name, email, created_at, updated_at) values (${person.name}, ${link.email}, now(), now()) returning id`);
        const userId = created[0].id;
        await tx.execute(sql`insert into auth_accounts (account_id, provider_id, user_id, password, created_at, updated_at) values (${userId}, 'credential', ${userId}, ${passwordHash}, now(), now())`);
        await tx.execute(sql`insert into user_access (user_id, role) values (${userId}, ${link.role})`);
        await tx.execute(sql`update staff_invitations set accepted_at = now(), user_id = ${userId} where id = ${link.id}`);
        await audit(tx, "staff_joined", userId, userId, { invitationId: link.id, role: link.role });
        return { kind: "invite" as const };
      }
      const staff = await lockStaff(tx, link.user_id!);
      const { rows: updated } = await tx.execute<{ id: string }>(sql`update auth_accounts set password = ${passwordHash}, updated_at = now() where user_id = ${link.user_id} and provider_id = 'credential' returning id`);
      if (updated.length !== 1) throw BAD_LINK();
      const { rows: ended } = await tx.execute<{ id: string }>(sql`delete from auth_sessions where user_id = ${link.user_id} returning id`);
      await tx.execute(sql`update staff_invitations set accepted_at = now() where id = ${link.id}`);
      await audit(tx, "staff_password_set", link.user_id!, link.user_id, { invitationId: link.id, role: staff.role, sessionsEnded: ended.length });
      return { kind: "password" as const };
    });
  } catch (error) {
    if (pgErrorCode(error) === "23505") throw BAD_LINK();
    throw error;
  }
}

// --- Reading -----------------------------------------------------------------------------------------------------------

export type StaffMember = { userId: string; name: string; email: string; role: Role; disabled: boolean; createdAt: Date; lastSignInAt: Date | null; activeSessions: number };
export type StaffLink = { id: string; kind: "invite" | "password"; email: string; role: StaffRole | null; state: "open" | "expired" | "accepted" | "revoked"; createdAt: Date; expiresAt: Date };
export type AccessEvent = { id: number; event: string; at: Date; actorName: string | null; subjectName: string | null; detail: Record<string, unknown> };

/** Everyone with Admin access (the Owner first), recent links and the access history, for the Staff & access page. */
export async function staffOverview(db: Db, principal: Principal): Promise<{ members: StaffMember[]; links: StaffLink[]; history: AccessEvent[] }> {
  assertPermission(principal, "users:manage");
  // Three independent reads, side by side.
  const [members, links, history] = await Promise.all([
    db.execute<{ user_id: string; name: string; email: string; role: Role; disabled: boolean; created_at: Date; last_sign_in: Date | null; sessions: number }>(sql`
    select a.user_id, u.name, u.email, a.role, a.disabled_at is not null as disabled, a.created_at,
           (select max(e.created_at) from auth_events e where e.event = 'sign_in' and e.subject_user_id = a.user_id) as last_sign_in,
           (select count(*)::int from auth_sessions s where s.user_id = a.user_id and s.expires_at > now()) as sessions
      from user_access a join auth_users u on u.id = a.user_id
     order by a.role = 'owner' desc, a.disabled_at is not null, lower(u.name)`),
    db.execute<{ id: string; kind: "invite" | "password"; email: string; role: StaffRole | null; state: StaffLink["state"]; created_at: Date; expires_at: Date }>(sql`
    select id, kind, email, role, created_at, expires_at,
           case when accepted_at is not null then 'accepted' when revoked_at is not null then 'revoked' when expires_at <= now() then 'expired' else 'open' end as state
      from staff_invitations order by created_at desc limit 30`),
    db.execute<{ id: number; event: string; created_at: Date; actor: string | null; subject: string | null; detail: Record<string, unknown> }>(sql`
    select e.id, e.event, e.created_at, actor.name as actor, subject.name as subject, e.detail
      from auth_events e left join auth_users actor on actor.id = e.actor_user_id left join auth_users subject on subject.id = e.subject_user_id
     where e.event like 'staff\\_%' or e.event = 'access_changed'
     order by e.id desc limit 50`),
  ]);
  return {
    members: members.rows.map((r) => ({ userId: r.user_id, name: r.name, email: r.email, role: r.role, disabled: r.disabled, createdAt: new Date(r.created_at), lastSignInAt: r.last_sign_in ? new Date(r.last_sign_in) : null, activeSessions: r.sessions })),
    links: links.rows.map((r) => ({ id: r.id, kind: r.kind, email: r.email, role: r.role, state: r.state, createdAt: new Date(r.created_at), expiresAt: new Date(r.expires_at) })),
    history: history.rows.map((r) => ({ id: Number(r.id), event: r.event, at: new Date(r.created_at), actorName: r.actor, subjectName: r.subject, detail: r.detail })),
  };
}

/** Display names of Admin users (for order history and other audit trails), by id. Names only. */
export async function userNames(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((i) => UUID.test(i)))];
  if (unique.length === 0) return new Map();
  const { rows } = await db.execute<{ id: string; name: string; role: Role | null }>(
    sql`select u.id, u.name, a.role from auth_users u left join user_access a on a.user_id = u.id where u.id in (${sql.join(unique.map((u) => sql`${u}::uuid`), sql`, `)})`,
  );
  return new Map(rows.map((r) => [r.id, r.role ? `${r.name} (${ROLE_INFO[r.role].label})` : `${r.name} (former Admin user)`]));
}
