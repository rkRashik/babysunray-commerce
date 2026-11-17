import pg from "pg";
import { APP_ROLE, assertStagingTarget, parseStagingUrl } from "../../src/db/hosted-target.mts";

// Fails closed before any staging test runs: the database must be hosted, reached through the transaction pooler, marked
// 'babysunray:staging', reached as the application role (never an administrator), carry the application's schema, and
// hold no records this suite did not create (no real customer, no real account). Anything else stops the whole run.
export default async function setup(): Promise<void> {
  const env = process.env as Record<string, string | undefined>;
  const conn = parseStagingUrl(env, "STAGING_DATABASE_URL", { pooled: true });
  const client = new pg.Client({ host: conn.host, port: conn.port, database: conn.database, user: conn.user, password: conn.password, ssl: conn.ssl, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    const identity = await assertStagingTarget(client);
    if (identity.user !== APP_ROLE) throw new Error(`The staging suite must connect as ${APP_ROLE} (through the pooler), not as an administrator.`);
    if (identity.superuser) throw new Error("Refusing: the staging connection is a superuser.");
    if ((await client.query("select to_regclass('public.orders') as t")).rows[0].t === null) throw new Error("The staging database has no application tables. Run npm run db:migrate:staging first.");
    const { rows } = await client.query<{ n: string }>(
      `select ((select count(*) from orders where customer_name not like 'Staging Test %')
             + (select count(*) from auth_users where email not like '%@staging.example.test'))::text as n`,
    );
    if (Number(rows[0].n) > 0) throw new Error("Refusing: the staging database holds orders or accounts this suite did not create. It may contain real data.");
  } finally {
    await client.end();
  }
}
