-- Staff accounts and invitations (ADR-0013). Reviewed by hand. Additive in effect:
-- - staff_invitations: one-time invitation and set-password links for staff, stored as SHA-256 digests only.
-- - user_access: the role check also allows the four staff roles. Every existing row ('owner') stays valid.
-- - auth_events: the event check also allows the Staff & access events. Every existing row stays valid.
-- - tracking_rate_limits: the bucket check also allows 'staff-invite'. Every existing row stays valid.
-- The DROP/ADD pairs only widen checks. No existing column, row, trigger or function changes.
CREATE TABLE "staff_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"user_id" uuid,
	"token_sha256" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "staff_invitations_token_sha256_key" UNIQUE("token_sha256"),
	CONSTRAINT "staff_invitations_kind_valid" CHECK ("staff_invitations"."kind" in ('invite', 'password')),
	CONSTRAINT "staff_invitations_role_valid" CHECK ("staff_invitations"."role" in ('manager', 'orders', 'catalogue', 'inventory')),
	CONSTRAINT "staff_invitations_kind_consistent" CHECK (("staff_invitations"."kind" = 'invite') = ("staff_invitations"."role" is not null) and ("staff_invitations"."kind" = 'invite' or "staff_invitations"."user_id" is not null)),
	CONSTRAINT "staff_invitations_email_valid" CHECK ("staff_invitations"."email" = lower("staff_invitations"."email") and length("staff_invitations"."email") between 3 and 254),
	CONSTRAINT "staff_invitations_token_format" CHECK ("staff_invitations"."token_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "staff_invitations_end_consistent" CHECK (not ("staff_invitations"."accepted_at" is not null and "staff_invitations"."revoked_at" is not null) and ("staff_invitations"."accepted_at" is null or "staff_invitations"."user_id" is not null) and "staff_invitations"."expires_at" > "staff_invitations"."created_at")
);
--> statement-breakpoint
ALTER TABLE "auth_events" DROP CONSTRAINT "auth_events_event_valid";--> statement-breakpoint
ALTER TABLE "tracking_rate_limits" DROP CONSTRAINT "tracking_rate_limits_bucket_valid";--> statement-breakpoint
ALTER TABLE "user_access" DROP CONSTRAINT "user_access_role_valid";--> statement-breakpoint
ALTER TABLE "staff_invitations" ADD CONSTRAINT "staff_invitations_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_invitations" ADD CONSTRAINT "staff_invitations_created_by_user_id_auth_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_invitations_open_email_key" ON "staff_invitations" USING btree ("email") WHERE "staff_invitations"."accepted_at" is null and "staff_invitations"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "staff_invitations_created_at_idx" ON "staff_invitations" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "auth_events" ADD CONSTRAINT "auth_events_event_valid" CHECK ("auth_events"."event" in ('sign_in', 'sign_in_failed', 'session_ended', 'password_changed', 'owner_created', 'owner_password_reset', 'access_changed', 'staff_invited', 'staff_invitation_revoked', 'staff_joined', 'staff_role_changed', 'staff_disabled', 'staff_enabled', 'staff_sessions_revoked', 'staff_password_link', 'staff_password_set'));--> statement-breakpoint
ALTER TABLE "tracking_rate_limits" ADD CONSTRAINT "tracking_rate_limits_bucket_valid" CHECK ("tracking_rate_limits"."bucket" in ('failure', 'checkout', 'admin-setup', 'admin-recovery', 'staff-invite') or "tracking_rate_limits"."bucket" ~ '^link:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or "tracking_rate_limits"."bucket" ~ '^checkout-client:[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "user_access" ADD CONSTRAINT "user_access_role_valid" CHECK ("user_access"."role" in ('owner', 'manager', 'orders', 'catalogue', 'inventory'));