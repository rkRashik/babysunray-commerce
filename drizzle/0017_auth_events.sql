-- Gate H.39: an append-only audit of authentication and access. Reviewed by hand. Additive: one new table, its
-- append-only trigger (append_only_reject_change() from migration 0008), and a trigger that records every change
-- to user_access (grant, role change, disable, enable, removal) in the same transaction, so an access change can
-- never happen unrecorded. No existing table, row or constraint is changed. user_access_audit fires before
-- user_access_revoke_sessions (triggers run in name order), so it can count the sessions about to be revoked.
-- Limitation, as for every trigger here: the table owner or a superuser can drop or disable it.
CREATE TABLE "auth_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "auth_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"event" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_user_id" uuid,
	"subject_user_id" uuid,
	"session_id" uuid,
	"transport" text,
	"subject_digest" text,
	"detail" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_events_event_valid" CHECK ("auth_events"."event" in ('sign_in', 'sign_in_failed', 'session_ended', 'password_changed', 'owner_created', 'owner_password_reset', 'access_changed')),
	CONSTRAINT "auth_events_actor_type_valid" CHECK ("auth_events"."actor_type" in ('user', 'anonymous', 'operator', 'system')),
	CONSTRAINT "auth_events_actor_consistent" CHECK (("auth_events"."actor_type" = 'user') = ("auth_events"."actor_user_id" is not null)),
	CONSTRAINT "auth_events_transport_valid" CHECK ("auth_events"."transport" in ('browser', 'native', 'cli', 'database')),
	CONSTRAINT "auth_events_failed_sign_in_anonymous" CHECK (("auth_events"."event" = 'sign_in_failed') = ("auth_events"."actor_type" = 'anonymous') and ("auth_events"."event" <> 'sign_in_failed' or "auth_events"."subject_user_id" is null)),
	CONSTRAINT "auth_events_subject_digest_valid" CHECK (("auth_events"."subject_digest" is null or "auth_events"."event" = 'sign_in_failed') and ("auth_events"."subject_digest" is null or "auth_events"."subject_digest" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "auth_events_session_required" CHECK ("auth_events"."event" not in ('sign_in', 'session_ended') or "auth_events"."session_id" is not null),
	CONSTRAINT "auth_events_detail_object" CHECK (jsonb_typeof("auth_events"."detail") = 'object' and length("auth_events"."detail"::text) <= 1000)
);
--> statement-breakpoint
CREATE INDEX "auth_events_created_at_idx" ON "auth_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "auth_events_subject_user_id_id_idx" ON "auth_events" USING btree ("subject_user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_events_sign_in_session_key" ON "auth_events" USING btree ("session_id") WHERE "auth_events"."event" = 'sign_in';--> statement-breakpoint
CREATE UNIQUE INDEX "auth_events_session_ended_session_key" ON "auth_events" USING btree ("session_id") WHERE "auth_events"."event" = 'session_ended';--> statement-breakpoint
CREATE TRIGGER "auth_events_append_only"
BEFORE UPDATE OR DELETE OR TRUNCATE ON "auth_events"
FOR EACH STATEMENT EXECUTE FUNCTION "append_only_reject_change"();
--> statement-breakpoint
CREATE FUNCTION "user_access_audit"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  subject uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.role IS NOT DISTINCT FROM OLD.role AND (NEW.disabled_at IS NULL) = (OLD.disabled_at IS NULL) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "public"."auth_events" ("event", "actor_type", "subject_user_id", "transport", "detail")
  VALUES ('access_changed', 'system', subject, 'database', jsonb_build_object(
    'operation', lower(TG_OP),
    'roleBefore', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.role END,
    'roleAfter', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.role END,
    'disabledBefore', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.disabled_at IS NOT NULL END,
    'disabledAfter', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.disabled_at IS NOT NULL END,
    'openSessions', (SELECT count(*) FROM "public"."auth_sessions" WHERE "user_id" = subject)));
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "user_access_audit"
AFTER INSERT OR UPDATE OR DELETE ON "user_access"
FOR EACH ROW EXECUTE FUNCTION "user_access_audit"();
