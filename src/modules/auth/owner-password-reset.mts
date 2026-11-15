// Sets a new password for the installation's one active Owner and signs out all of that Owner's sessions,
// in one transaction. Used only by the local CLI (scripts/reset-owner-password.mts) and its tests; no HTTP
// route, Server Action or application start-up calls it. Plain TypeScript so Node can run it directly.
//
// Trust boundary: whoever can run this against the database can take over the Owner account. That is
// already true of anyone with write access to auth_accounts, so this adds no new power; it replaces a
// manual SQL procedure with a checked one. It is not a production account-recovery mechanism.
//
// The password is hashed with Better Auth's own scrypt (`better-auth/crypto`), the same as the bootstrap,
// and only the Owner's existing credential row ('credential' provider, account_id = user id) is changed.
import { hashPassword } from "better-auth/crypto";
import type { Client } from "pg";
import { assertConnectedIdentity, type DatabaseTarget } from "../../db/connection-guard.mts";
import { normalizeEmail, validatePassword } from "./owner-bootstrap.mts";

type ActiveOwner = { userId: string; email: string };

async function activeOwners(client: Pick<Client, "query">): Promise<ActiveOwner[]> {
  const { rows } = await client.query<{ user_id: string; email: string }>(
    `select a.user_id, u.email from public.user_access a join public.auth_users u on u.id = a.user_id
      where a.role = 'owner' and a.disabled_at is null`,
  );
  return rows.map((r) => ({ userId: r.user_id, email: r.email }));
}

/** Stops unless there is exactly one active Owner. The CLI calls it before asking for anything. */
export async function assertSingleActiveOwner(client: Pick<Client, "query">): Promise<void> {
  const owners = await activeOwners(client);
  if (owners.length === 0) throw new Error("This installation has no active Owner. Nothing was changed.");
  if (owners.length > 1) throw new Error("This installation has more than one active Owner, so the account is ambiguous. Nothing was changed.");
}

/**
 * Confirms the connection's identity with PostgreSQL, then, under table locks that also serialise a
 * concurrent reset or bootstrap: checks that exactly one active Owner exists and has this email, that it
 * has exactly one credential account, replaces that account's password hash and deletes all of the Owner's
 * sessions (cookie and Bearer alike). Any failure rolls everything back. Never creates a user, changes a
 * role or touches another account.
 */
export async function resetOwnerPassword(
  client: Client,
  target: DatabaseTarget,
  input: { email: string; password: string },
): Promise<{ revokedSessions: number }> {
  await assertConnectedIdentity(client, target);
  const email = normalizeEmail(input.email);
  // Hash before the transaction: scrypt is deliberately slow and must not hold the locks.
  const passwordHash = await hashPassword(validatePassword(input.password));

  await client.query("begin");
  try {
    // Same lock order as the bootstrap (auth_users, user_access), then the credentials. Reads still work.
    await client.query("lock table public.auth_users, public.user_access, public.auth_accounts in exclusive mode");
    await assertSingleActiveOwner(client);
    const [owner] = await activeOwners(client);
    if (owner.email !== email) throw new Error("This email is not the active Owner's. Nothing was changed.");

    const accounts = await client.query<{ id: string }>(
      "select id from public.auth_accounts where user_id = $1 and provider_id = 'credential' and account_id = $2",
      [owner.userId, owner.userId],
    );
    if (accounts.rows.length !== 1) {
      throw new Error("The Owner does not have exactly one password credential. Nothing was changed.");
    }
    const updated = await client.query("update public.auth_accounts set password = $1, updated_at = now() where id = $2", [
      passwordHash,
      accounts.rows[0].id,
    ]);
    if (updated.rowCount !== 1) throw new Error("The password could not be changed. Nothing was changed.");
    const revoked = await client.query("delete from public.auth_sessions where user_id = $1", [owner.userId]);
    await client.query("commit");
    return { revokedSessions: revoked.rowCount ?? 0 };
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}
