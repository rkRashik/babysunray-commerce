// A read-only audit of a hosted database's privilege boundary (Gate H.45; ADR-0009). It only reads the system catalogs
// (no row of application data, no change), so any role may run it, including the application role itself. Used by the
// staging migration command after it runs db/hosted/privileges.sql, and by the staging test suite.

import type { Client } from "pg";

/** Tables whose rows may only be added: their triggers refuse UPDATE and DELETE (migrations 0001 to 0018). */
export const APPEND_ONLY_TABLES = [
  "stock_movements",
  "order_events",
  "payment_entries",
  "export_requests",
  "catalogue_imports",
  "product_reviews",
  "policy_draft_events",
  "product_publication_events",
  "auth_events",
  "courier_statement_checks",
] as const;

/** Supabase's Data API roles: none of them may reach an application table, sequence or function. */
export const API_ROLES = ["anon", "authenticated", "service_role"] as const;
const SCHEMAS = ["public", "drizzle"];

export type Finding = { severity: "critical" | "high"; check: string; object: string };
/** Reported, never a failure: something this connection cannot change and that does not reach our objects. */
export type Warning = { severity: "warning"; check: string; object: string };

export type DefaultEntry = { owner: string; ownerSuperuser: boolean; connectionIsMember: boolean; scope: string; kind: string; privilege: string };

// Supabase's own default privileges (its `supabase_admin` grants the API roles everything on tables and sequences it
// creates in `public`). They apply only to objects that role creates and cannot be changed by the migration role, which
// is not a member of it. The exemption is exactly this and nothing broader: that owner name, a superuser, a role this
// connection is not a member of, the `public` schema only (never an all-schemas entry), tables and sequences, and only
// privileges Supabase is known to grant. Any other owner, schema, kind or privilege is a finding.
const PLATFORM_OWNER = "supabase_admin";
const KNOWN_PLATFORM_PRIVILEGES: Record<string, readonly string[]> = {
  r: ["DELETE", "INSERT", "MAINTAIN", "REFERENCES", "SELECT", "TRIGGER", "TRUNCATE", "UPDATE"],
  S: ["SELECT", "UPDATE", "USAGE"],
};
export function isPlatformDefault(entry: DefaultEntry): boolean {
  return entry.owner === PLATFORM_OWNER && entry.ownerSuperuser && !entry.connectionIsMember && entry.scope === "public" && (KNOWN_PLATFORM_PRIVILEGES[entry.kind]?.includes(entry.privilege) ?? false);
}

type Query = Pick<Client, "query">;

const roleExists = async (client: Query, role: string) => (await client.query("select 1 from pg_roles where rolname = $1", [role])).rows.length > 0;

/** Every privilege problem found; empty means the boundary holds. Object names only, never data. */
export async function auditPrivileges(client: Query, appRole: string, apiRoles: readonly string[] = API_ROLES): Promise<Finding[]> {
  return (await auditPrivilegeReport(client, appRole, apiRoles)).findings;
}

/** The findings (any of which fails the audit) and the platform-owned warnings (reported, not failures). */
/** `apiRoles` is only ever overridden by tests, which cannot create Supabase's roles on plain PostgreSQL. */
export async function auditPrivilegeReport(client: Query, appRole: string, apiRoles: readonly string[] = API_ROLES): Promise<{ findings: Finding[]; warnings: Warning[] }> {
  const findings: Finding[] = [];
  const warnings: Warning[] = [];
  const add = (severity: Finding["severity"], check: string, object: string) => findings.push({ severity, check, object });

  for (const role of apiRoles) {
    if (!(await roleExists(client, role))) continue;
    const tables = await client.query<{ name: string }>(
      `select n.nspname || '.' || c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = any($2) and c.relkind in ('r', 'p', 'v', 'm', 'f')
         and (has_any_column_privilege($1, c.oid, 'select') or has_any_column_privilege($1, c.oid, 'insert') or has_any_column_privilege($1, c.oid, 'update')
              or has_table_privilege($1, c.oid, 'delete') or has_table_privilege($1, c.oid, 'truncate'))
       order by 1`,
      [role, SCHEMAS],
    );
    for (const t of tables.rows) add("critical", `${role} can read or change a table`, t.name);
    const sequences = await client.query<{ name: string }>(
      `select n.nspname || '.' || c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = any($2) and c.relkind = 'S' and (has_sequence_privilege($1, c.oid, 'usage') or has_sequence_privilege($1, c.oid, 'update'))
       order by 1`,
      [role, SCHEMAS],
    );
    for (const s of sequences.rows) add("high", `${role} can use a sequence`, s.name);
    const functions = await client.query<{ name: string }>(
      `select n.nspname || '.' || p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and has_function_privilege($1, p.oid, 'execute') order by 1`,
      [role],
    );
    for (const f of functions.rows) add("high", `${role} can execute a function`, f.name);
    // Schema-level entries for public, and global ones (defaclnamespace 0); trigger functions are left to the PUBLIC check.
    const defaults = await client.query<DefaultEntry>(
      `select o.rolname as owner, o.rolsuper as "ownerSuperuser", pg_has_role(current_user, d.defaclrole, 'member') as "connectionIsMember",
              coalesce(n.nspname, 'all schemas') as scope, d.defaclobjtype::text as kind, a.privilege_type as privilege
       from pg_default_acl d join pg_roles o on o.oid = d.defaclrole left join pg_namespace n on n.oid = d.defaclnamespace, aclexplode(d.defaclacl) a
       where (n.nspname = 'public' or d.defaclnamespace = 0) and d.defaclobjtype in ('r', 'S') and a.grantee = (select oid from pg_roles where rolname = $1)`,
      [role],
    );
    for (const d of defaults.rows) {
      if (isPlatformDefault(d)) warnings.push({ severity: "warning", check: `${role} would get privileges on objects created by Supabase's own role ${d.owner} (Supabase-managed; this role cannot change them)`, object: `${d.scope} (${d.kind}) ${d.privilege}` });
      else add("high", `${role} would get privileges on new objects (default privileges)`, `${d.scope} (${d.kind})`);
    }
    const schemas = await client.query<{ name: string }>(
      "select nspname as name from pg_namespace where (nspname = 'drizzle' and has_schema_privilege($1, oid, 'usage')) or (nspname = any($2) and has_schema_privilege($1, oid, 'create'))",
      [role, SCHEMAS],
    );
    for (const s of schemas.rows) add("high", `${role} can use the migration schema or create objects`, s.name);
  }

  // PUBLIC (every role, including the API roles) on tables and sequences; function EXECUTE is reported per API role above.
  const toPublic = await client.query<{ name: string }>(
    `select n.nspname || '.' || c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
     where n.nspname = any($1) and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S') and a.grantee = 0 order by 1`,
    [SCHEMAS],
  );
  for (const t of toPublic.rows) add("critical", "PUBLIC has a privilege on a table or sequence", t.name);

  // Row-level security policies exist for the application role only: a policy that names another role (or PUBLIC, the
  // default when no role is given) would open a table to it.
  const policies = await client.query<{ name: string }>(
    "select tablename || '.' || policyname as name from pg_policies where schemaname = 'public' and not (roles = array[$1]::name[]) order by 1",
    [appRole],
  );
  for (const p of policies.rows) add("high", "a row-level security policy applies to a role other than the application role", p.name);

  if (!(await roleExists(client, appRole))) {
    add("high", "the application role does not exist", appRole);
    return { findings, warnings };
  }
  const attributes = await client.query<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean }>(
    "select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication from pg_roles where rolname = $1",
    [appRole],
  );
  for (const [attribute, on] of Object.entries(attributes.rows[0])) if (on) add("critical", `the application role has ${attribute}`, appRole);
  // The failure found on the first hosted run: row-level security on with no policy for the application role denies it every row.
  const denied = await client.query<{ name: string }>(
    `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity
       and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname and $1 = any(p.roles)) order by 1`,
    [appRole],
  );
  for (const t of denied.rows) add("high", "row-level security is on and the application role has no policy (the application would be denied every row)", t.name);
  const memberships = await client.query<{ name: string }>(
    "select r.rolname as name from pg_auth_members m join pg_roles r on r.oid = m.roleid where m.member = (select oid from pg_roles where rolname = $1)",
    [appRole],
  );
  for (const m of memberships.rows) add("high", "the application role is a member of another role", m.name);
  const owned = await client.query<{ name: string }>(
    `select n.nspname || '.' || c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relowner = (select oid from pg_roles where rolname = $1) and n.nspname not in ('pg_catalog', 'information_schema') order by 1`,
    [appRole],
  );
  for (const o of owned.rows) add("high", "the application role owns an object (owners bypass grants)", o.name);
  const create = await client.query<{ name: string }>(
    "select nspname as name from pg_namespace where nspname = any($2) and has_schema_privilege($1, oid, 'create')",
    [appRole, SCHEMAS],
  );
  for (const c of create.rows) add("high", "the application role can create objects in a schema", c.name);
  const tables = await client.query<{ name: string; sel: boolean; ins: boolean; upd: boolean; del: boolean; trunc: boolean; refs: boolean; trig: boolean }>(
    `select c.relname as name, has_table_privilege($1, c.oid, 'select') as sel, has_table_privilege($1, c.oid, 'insert') as ins,
            has_table_privilege($1, c.oid, 'update') as upd, has_table_privilege($1, c.oid, 'delete') as del,
            has_table_privilege($1, c.oid, 'truncate') as trunc, has_table_privilege($1, c.oid, 'references') as refs,
            has_table_privilege($1, c.oid, 'trigger') as trig
     from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1`,
    [appRole],
  );
  const appendOnly = new Set<string>(APPEND_ONLY_TABLES);
  for (const t of tables.rows) {
    if (!t.sel || !t.ins) add("high", "the application role cannot read or add rows (the application would fail)", t.name);
    if (t.trunc || t.refs || t.trig) add("high", "the application role has TRUNCATE, REFERENCES or TRIGGER", t.name);
    if (appendOnly.has(t.name) && (t.upd || t.del)) add("high", "the application role can UPDATE or DELETE an append-only table", t.name);
  }
  const drizzleAccess = await client.query<{ n: string }>(
    "select count(*)::text as n from pg_namespace where nspname = 'drizzle' and has_schema_privilege($1, oid, 'usage')",
    [appRole],
  );
  if (Number(drizzleAccess.rows[0].n) > 0) add("high", "the application role can use the migration history schema", "drizzle");
  return { findings, warnings };
}
