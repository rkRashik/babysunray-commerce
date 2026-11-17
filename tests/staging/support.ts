import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { Db } from "../../src/db/database";
import { parseStagingUrl } from "../../src/db/hosted-target.mts";
import { supabaseMediaStore } from "../../src/modules/media/supabase-store";

// Shared by the staging suite (tests/staging). Everything it creates is fictional and marked: customers are named
// "Staging Test ...", e-mail addresses end in @staging.example.test, slugs and SKUs start with "stg-".

export const env = process.env as Record<string, string | undefined>;
export const STAGING_CUSTOMER_PREFIX = "Staging Test ";
export const STAGING_EMAIL_DOMAIN = "@staging.example.test";
export const tag = () => `stg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** A pool through the transaction pooler as the application role, sized like one serverless function instance. */
export function stagingPool(max = 2, connectionTimeoutMillis = 5_000): Pool {
  const conn = parseStagingUrl(env, "STAGING_DATABASE_URL", { pooled: true });
  const pool = new Pool({ host: conn.host, port: conn.port, database: conn.database, user: conn.user, password: conn.password, ssl: conn.ssl, max, connectionTimeoutMillis, idleTimeoutMillis: 5_000 });
  pool.on("error", () => undefined);
  return pool;
}
export const dbOf = (pool: Pool): Db => drizzle({ client: pool });

export const supabase = () => ({ url: env.STAGING_SUPABASE_URL!, publishable: env.STAGING_SUPABASE_PUBLISHABLE_KEY!, secret: env.STAGING_SUPABASE_SECRET_KEY!, bucket: env.STAGING_STORAGE_BUCKET! });
export const stagingStore = () => supabaseMediaStore({ origin: new URL(supabase().url).origin, bucket: supabase().bucket, serviceKey: supabase().secret });
/** A new random password for each fictional staging account: never the committed test password. */
export const randomPassword = () => randomBytes(24).toString("base64url");
/** Disables fictional accounts after a run (their sessions are revoked by the user_access trigger); rows stay for the ledger. */
export async function disableAccounts(pool: Pool, userIds: string[]): Promise<void> {
  if (userIds.length) await pool.query("update user_access set disabled_at = now() where user_id = any($1::uuid[]) and disabled_at is null", [userIds]);
}
export const CUSTOMER = { customerName: `${STAGING_CUSTOMER_PREFIX}Customer`, customerPhone: "+880 1711-000999", deliveryAddress: "House 1, Road 2, Staging Area", deliveryZone: "dhaka_city" as const };
