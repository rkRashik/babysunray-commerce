import "server-only";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { sql } from "drizzle-orm";
import { type Db, pgErrorCode } from "@/db/database";
import { DomainError } from "../domain-error";
import { type EmailSender, simpleMessage } from "../email/service";
import { consumePublicLimit } from "../rate-limit/service";
import { normalizeEmail, validateOwnerInput, validatePassword } from "./owner-input";

// First-time Admin setup in the browser (ADR-0012), and Owner account recovery.
//
// Setup creates the installation's first Owner. It is open only while no Owner has active access, and only to someone who
// holds the SETUP GRANT: ADMIN_SETUP_TOKEN, a long random value the founder sets out of band (in the host's environment
// settings), typed into the setup form (never in a URL, never stored in the browser). The token is useless once an Owner
// exists: the operation refuses server-side whatever is sent. When email is set up, the founder also proves the address
// with a 6-digit code sent to it (15 minutes); without email the account is created with an unverified address, and the
// page says so. Creation runs in one transaction under exclusive locks on the user and access tables, so concurrent or
// repeated attempts create at most one Owner; it never changes or removes an existing account. Ten one-time recovery codes
// are created with the Owner and shown once.
//
// Recovery: an Owner who lost the password redeems one unused recovery code with the account's email and a new password;
// every session of that Owner ends. Both operations are rate limited storewide and audited (auth_events).

export const SETUP_TOKEN_MIN = 32;
const CODE_MINUTES = 15;
const SETUP_IDENTIFIER = "admin-setup";
const ATTEMPTS_PER_MINUTE = 10;
export const RECOVERY_CODE_COUNT = 10;

type Env = Record<string, string | undefined>;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Whether a setup grant is configured (never its value). */
export const setupGrantConfigured = (env: Env) => (env.ADMIN_SETUP_TOKEN?.trim().length ?? 0) >= SETUP_TOKEN_MIN;

function grantMatches(env: Env, given: unknown): boolean {
  if (!setupGrantConfigured(env) || typeof given !== "string" || given.length > 512) return false;
  const a = Buffer.from(sha256(env.ADMIN_SETUP_TOKEN!.trim()), "hex");
  const b = Buffer.from(sha256(given.trim()), "hex");
  return timingSafeEqual(a, b);
}

/** Whether an Owner with active access exists; and whether this database has the setup tables (migration 0021). */
export async function setupState(db: Db): Promise<{ ownerExists: boolean; schemaReady: boolean }> {
  const { rows } = await db.execute<{ owners: number; ready: boolean }>(sql`select
    (select count(*) from user_access where role = 'owner' and disabled_at is null)::int as owners,
    to_regclass('public.owner_recovery_codes') is not null as ready`);
  return { ownerExists: rows[0].owners > 0, schemaReady: rows[0].ready };
}

const refused = (message: string) => new DomainError("FORBIDDEN", message);
const CLOSED = "Setup is closed: this installation already has an Owner. Sign in instead.";
const BAD_GRANT = "The setup code is not right. Check the value set as ADMIN_SETUP_TOKEN and try again.";

async function guard(db: Db, env: Env, token: unknown, bucket: "admin-setup" | "admin-recovery") {
  if (!(await consumePublicLimit(db, bucket, ATTEMPTS_PER_MINUTE))) throw new DomainError("RATE_LIMITED", "Too many attempts. Wait a minute and try again.");
  if (bucket === "admin-setup") {
    if ((await setupState(db)).ownerExists) throw refused(CLOSED);
    if (!grantMatches(env, token)) throw refused(BAD_GRANT);
  }
}

/**
 * Step 1: checks the grant and, when email is set up, sends a 6-digit code to the address (replacing any earlier one).
 * Returns whether a code was sent; without email the next step needs no code and the address stays unverified.
 */
export async function startSetup(db: Db, input: { token: unknown; email: unknown }, deps: { env: Env; send: EmailSender | null; storeName: string }): Promise<{ codeSent: boolean }> {
  await guard(db, deps.env, input.token, "admin-setup");
  const email = normalizeEmail(String(input.email ?? ""));
  if (!deps.send) return { codeSent: false };
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.transaction(async (tx) => {
    await tx.execute(sql`delete from auth_verifications where identifier = ${SETUP_IDENTIFIER}`);
    await tx.execute(sql`insert into auth_verifications (identifier, value, expires_at) values (${SETUP_IDENTIFIER}, ${sha256(`${email}:${code}`)}, now() + make_interval(mins => ${CODE_MINUTES}))`);
  });
  await deps.send(
    simpleMessage({
      to: email,
      subject: `${deps.storeName} Admin setup code`,
      lines: [`Your setup code is ${code}. It works for ${CODE_MINUTES} minutes.`, `আপনার সেটআপ কোড ${code}। এটি ${CODE_MINUTES} মিনিট কাজ করবে।`, "If you did not ask for it, ignore this email."],
    }),
  );
  return { codeSent: true };
}

export type SetupResult = { userId: string; emailVerified: boolean; recoveryCodes: string[] };

const newRecoveryCode = () => {
  const raw = randomBytes(10).toString("hex").toUpperCase();
  return `${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15, 20)}`;
};
const recoveryDigest = (code: string) => sha256(code.trim().toUpperCase().replace(/[^0-9A-F]/g, ""));

/**
 * Step 2: creates the first Owner (user, password credential, owner access, audit row and recovery codes) in one locked
 * transaction. With email set up, `code` must be the one sent to this address. Refused once an active Owner exists.
 */
export async function completeSetup(
  db: Db,
  input: { token: unknown; email: unknown; name: unknown; password: unknown; code?: unknown },
  deps: { env: Env; emailRequired: boolean },
): Promise<SetupResult> {
  await guard(db, deps.env, input.token, "admin-setup");
  const owner = validateOwnerInput({ email: String(input.email ?? ""), name: String(input.name ?? ""), password: String(input.password ?? "") });
  const passwordHash = await hashPassword(owner.password);
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  try {
    const userId = await db.transaction(async (tx) => {
      await tx.execute(sql`lock table auth_users, user_access in exclusive mode`);
      const { rows: active } = await tx.execute<{ n: number }>(sql`select count(*)::int as n from user_access where role = 'owner' and disabled_at is null`);
      if (active[0].n > 0) throw refused(CLOSED);
      if (deps.emailRequired) {
        const digest = sha256(`${owner.email}:${String(input.code ?? "").trim()}`);
        const { rows } = await tx.execute<{ id: string }>(sql`delete from auth_verifications where identifier = ${SETUP_IDENTIFIER} and value = ${digest} and expires_at > now() returning id`);
        if (rows.length === 0) throw new DomainError("INVALID_INPUT", "The email code is wrong or has expired. Ask for a new code.");
      }
      const { rows: taken } = await tx.execute<{ n: number }>(sql`select count(*)::int as n from auth_users where email = ${owner.email}`);
      if (taken[0].n > 0) throw new DomainError("INVALID_INPUT", "An account with this email already exists. Use another email.");
      const { rows: user } = await tx.execute<{ id: string }>(
        sql`insert into auth_users (name, email, email_verified, created_at, updated_at) values (${owner.name}, ${owner.email}, ${deps.emailRequired}, now(), now()) returning id`,
      );
      const id = user[0].id;
      await tx.execute(sql`insert into auth_accounts (account_id, provider_id, user_id, password, created_at, updated_at) values (${id}, 'credential', ${id}, ${passwordHash}, now(), now())`);
      await tx.execute(sql`insert into user_access (user_id, role) values (${id}, 'owner')`);
      await tx.execute(
        sql`insert into auth_events (event, actor_type, subject_user_id, transport, detail) values ('owner_created', 'operator', ${id}, 'browser', ${JSON.stringify({ via: "web_setup", emailVerified: deps.emailRequired })}::jsonb)`,
      );
      for (const code of codes) await tx.execute(sql`insert into owner_recovery_codes (user_id, code_sha256) values (${id}, ${recoveryDigest(code)})`);
      return id;
    });
    return { userId, emailVerified: deps.emailRequired, recoveryCodes: codes };
  } catch (error) {
    // A concurrent setup that committed first, seen as a unique violation on the email.
    if (pgErrorCode(error) === "23505") throw refused(CLOSED);
    throw error;
  }
}

/** New recovery codes for a signed-in Owner (the old ones stop working). Shown once. */
export async function regenerateRecoveryCodes(db: Db, userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  await db.transaction(async (tx) => {
    await tx.execute(sql`delete from owner_recovery_codes where user_id = ${userId}`);
    for (const code of codes) await tx.execute(sql`insert into owner_recovery_codes (user_id, code_sha256) values (${userId}, ${recoveryDigest(code)})`);
  });
  return codes;
}

/** How many unused recovery codes the Owner has left. */
export async function recoveryCodesLeft(db: Db, userId: string): Promise<number> {
  const { rows } = await db.execute<{ n: number }>(sql`select count(*)::int as n from owner_recovery_codes where user_id = ${userId} and used_at is null`);
  return rows[0].n;
}

/**
 * Sets a new password for the active Owner with this email, spending one unused recovery code, and ends every session of
 * that Owner, in one transaction. The same answer for an unknown email, a used code or a wrong code.
 */
export async function recoverOwner(db: Db, input: { email: unknown; code: unknown; password: unknown }): Promise<void> {
  if (!(await consumePublicLimit(db, "admin-recovery", ATTEMPTS_PER_MINUTE))) throw new DomainError("RATE_LIMITED", "Too many attempts. Wait a minute and try again.");
  const email = normalizeEmail(String(input.email ?? ""));
  const passwordHash = await hashPassword(validatePassword(String(input.password ?? "")));
  const digest = recoveryDigest(String(input.code ?? ""));
  const wrong = new DomainError("INVALID_INPUT", "The email or recovery code is not right, or the code was already used.");
  await db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ user_id: string }>(sql`
      update owner_recovery_codes c set used_at = now()
        from auth_users u join user_access a on a.user_id = u.id and a.role = 'owner' and a.disabled_at is null
       where c.user_id = u.id and u.email = ${email} and c.code_sha256 = ${digest} and c.used_at is null
      returning c.user_id`);
    if (rows.length !== 1) throw wrong;
    const userId = rows[0].user_id;
    const { rows: updated } = await tx.execute<{ id: string }>(
      sql`update auth_accounts set password = ${passwordHash}, updated_at = now() where user_id = ${userId} and provider_id = 'credential' returning id`,
    );
    if (updated.length !== 1) throw wrong;
    const { rows: ended } = await tx.execute<{ id: string }>(sql`delete from auth_sessions where user_id = ${userId} returning id`);
    await tx.execute(
      sql`insert into auth_events (event, actor_type, subject_user_id, transport, detail) values ('owner_password_reset', 'operator', ${userId}, 'browser', ${JSON.stringify({ via: "recovery_code", sessionsRevoked: ended.length })}::jsonb)`,
    );
  });
}
