-- Hosted database privileges (Gate H.45; docs/operations/staging-setup.md, ADR-0009). Idempotent: run by
-- `npm run db:migrate:staging` before and after the migrations, as the migration role (Supabase's `postgres`), each
-- time in one transaction. Before: new tables are never granted to the API roles; after: the application role's grants.
-- It changes privileges only: no table, row, constraint, trigger or function is created, changed or removed.
--
-- 1. Supabase's Data API roles (anon, authenticated, service_role) get nothing in the application's schemas, now and
--    for objects created later. The Data API should also be switched off in the Dashboard; this is the second wall.
-- 2. PUBLIC can execute none of the application's existing functions (trigger functions; triggers do not need it, and
--    they cannot be called directly). PostgreSQL's built-in EXECUTE-to-PUBLIC default for NEW functions is global and is
--    not changed here; this script runs again after every migration and removes it then.
-- 3. The application role `babysunray_app` (created by the founder, LOGIN, no other attributes) may read and write
--    rows, but never TRUNCATE, REFERENCES or TRIGGER, never create objects, and never UPDATE or DELETE the ten
--    append-only tables (already refused by their triggers; refused here by privilege too).
-- Roles that do not exist are skipped, so the same script also runs on a plain PostgreSQL (the local test drives it).

do $$
declare
  api_role text;
  append_only text;
  has_drizzle boolean := exists (select 1 from pg_namespace where nspname = 'drizzle');
begin
  foreach api_role in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = api_role) then
      execute format('revoke all on all tables in schema public from %I', api_role);
      execute format('revoke all on all sequences in schema public from %I', api_role);
      execute format('revoke all on all functions in schema public from %I', api_role);
      execute format('alter default privileges in schema public revoke all on tables from %I', api_role);
      execute format('alter default privileges in schema public revoke all on sequences from %I', api_role);
      execute format('alter default privileges in schema public revoke all on functions from %I', api_role);
      if has_drizzle then
        execute format('revoke all on all tables in schema drizzle from %I', api_role);
        execute format('revoke all on all sequences in schema drizzle from %I', api_role);
        execute format('revoke all on schema drizzle from %I', api_role);
      end if;
    end if;
  end loop;

  revoke execute on all functions in schema public from public;

  if exists (select 1 from pg_roles where rolname = 'babysunray_app') then
    revoke create on schema public from babysunray_app;
    grant usage on schema public to babysunray_app;
    revoke all on all tables in schema public from babysunray_app;
    grant select, insert, update, delete on all tables in schema public to babysunray_app;
    revoke all on all sequences in schema public from babysunray_app;
    grant usage, select on all sequences in schema public to babysunray_app;
    -- Tables a later migration creates are usable at once (inside that migration's transaction), not only after this
    -- script runs again; their append-only revokes follow when it does (their triggers already refuse changes).
    alter default privileges in schema public grant select, insert, update, delete on tables to babysunray_app;
    alter default privileges in schema public grant usage, select on sequences to babysunray_app;
    foreach append_only in array array[
      'stock_movements', 'order_events', 'payment_entries', 'export_requests', 'catalogue_imports',
      'product_reviews', 'policy_draft_events', 'product_publication_events', 'auth_events', 'courier_statement_checks'
    ] loop
      if to_regclass(format('public.%I', append_only)) is not null then
        execute format('revoke update, delete on public.%I from babysunray_app', append_only);
      end if;
    end loop;
    if has_drizzle then
      execute 'revoke all on all tables in schema drizzle from babysunray_app';
      execute 'revoke all on schema drizzle from babysunray_app';
    end if;
  end if;
end
$$;
