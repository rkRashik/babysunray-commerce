-- Custom SQL migration file, put your code below! --
-- Losing access ends every session at once. When a user's user_access row is disabled (disabled_at set)
-- or removed, all of that user's sessions are deleted, so an existing cookie or Bearer token stops working
-- on every endpoint, including Better Auth's own self-service ones (get-session, change-password).
-- New sessions are already refused by the session-creation hook (ADR-0003). Re-enabling a user does not
-- restore sessions; the user signs in again.
-- Limitation: like the ledger trigger, the table owner or a superuser can drop or disable it.
CREATE FUNCTION "user_access_revoke_sessions"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (NEW.disabled_at IS NOT NULL AND OLD.disabled_at IS NULL) THEN
    DELETE FROM "public"."auth_sessions" WHERE "user_id" = OLD.user_id;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "user_access_revoke_sessions"
AFTER UPDATE OF "disabled_at" OR DELETE ON "user_access"
FOR EACH ROW EXECUTE FUNCTION "user_access_revoke_sessions"();
