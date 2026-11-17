// Creates the first Owner of an installation: user, credential account and owner access, in one
// transaction. Used only by the local CLI (scripts/bootstrap-owner.mts) and its tests; no HTTP route,
// server action or application start-up calls it. Plain TypeScript so Node can run it directly.
//
// The password is hashed with Better Auth's own scrypt implementation (`better-auth/crypto`, the default
// that sign-in verifies against), and the rows follow Better Auth's credential-account contract
// (provider_id 'credential', account_id = user id). The tests prove the result by signing in over HTTP.
import { hashPassword } from "better-auth/crypto";
import type { Client } from "pg";
import { assertConnectedIdentity, type DatabaseTarget } from "../../db/connection-guard.mts";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./password-policy.ts";

export type OwnerInput = { email: string; name: string; password: string };

// Control characters (including terminal escape sequences from arrow keys) are never meant as input here;
// in a password typed without echo they would be a silent typo.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Trimmed and lowercased, as Better Auth stores it. Never echoes the value. */
export function normalizeEmail(raw: string): string {
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("The email address is not valid.");
  return email;
}

/** The project password policy (password-policy.ts). Never echoes the value. */
export function validatePassword(password: string): string {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`The password must be ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters.`);
  }
  if (CONTROL.test(password)) throw new Error("The password must not contain control characters or arrow-key input.");
  return password;
}

/** Trims and lowercases the email and trims the name; checks the password length. Never echoes a value. */
export function validateOwnerInput(input: OwnerInput): OwnerInput {
  const email = normalizeEmail(input.email);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length < 1 || name.length > 100 || CONTROL.test(name)) {
    throw new Error("The name must be 1 to 100 characters, without control characters.");
  }
  return { email, name, password: validatePassword(input.password) };
}

/** How many authentication users exist. The CLI uses it to stop before asking for a password. */
export async function countAuthUsers(client: Pick<Client, "query">): Promise<number> {
  const { rows } = await client.query<{ n: number }>("select count(*)::int as n from public.auth_users");
  return rows[0].n;
}

/**
 * Confirms the connection's identity with PostgreSQL (database, role, non-superuser, local server), then
 * creates the first Owner. Refuses, changing nothing, if any authentication user or access row exists.
 * Concurrent runs serialise on an exclusive table lock, so at most one can succeed.
 */
export async function bootstrapFirstOwner(
  client: Client,
  target: DatabaseTarget,
  rawInput: OwnerInput,
): Promise<{ userId: string }> {
  await assertConnectedIdentity(client, target);
  const input = validateOwnerInput(rawInput);
  // Hash before the transaction: scrypt is deliberately slow and must not hold the lock.
  const passwordHash = await hashPassword(input.password);

  await client.query("begin");
  try {
    // Blocks every other writer of auth_users (and a second bootstrap) until commit; reads still work.
    await client.query("lock table public.auth_users, public.user_access in exclusive mode");
    const existing = await client.query<{ n: number }>(
      "select (select count(*) from public.auth_users) + (select count(*) from public.user_access) as n",
    );
    if (Number(existing.rows[0].n) > 0) {
      throw new Error("An account already exists. The first-Owner bootstrap only runs on an empty installation.");
    }
    const user = await client.query<{ id: string }>(
      `insert into public.auth_users (name, email, email_verified, created_at, updated_at)
       values ($1, $2, false, now(), now()) returning id`,
      [input.name, input.email],
    );
    const userId = user.rows[0].id;
    await client.query(
      `insert into public.auth_accounts (account_id, provider_id, user_id, password, created_at, updated_at)
       values ($1, 'credential', $2, $3, now(), now())`,
      [userId, userId, passwordHash],
    );
    await client.query("insert into public.user_access (user_id, role) values ($1, 'owner')", [userId]);
    // Recorded in the same transaction (migration 0017): an Owner never appears without its audit row. The access
    // grant itself is recorded by the user_access trigger.
    await client.query(
      "insert into public.auth_events (event, actor_type, subject_user_id, transport, detail) values ('owner_created', 'operator', $1, 'cli', '{}'::jsonb)",
      [userId],
    );
    await client.query("commit");
    return { userId };
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}
