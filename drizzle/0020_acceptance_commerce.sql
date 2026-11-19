-- Phase 5 (ADR-0011): founder acceptance commerce. Reviewed by hand. Additive only: six new tables and a widened check.
-- - customer_* : a separate Better Auth instance for customers (Google only). No column or reference reaches auth_users or
--   user_access, so a customer can never hold an Office permission. customer_accounts can hold no OAuth token or password.
-- - customer_orders: the link from a website order to the signed-in customer who placed it (none for guest orders).
-- - policy_publications: append-only, founder-approved published versions of the customer policies.
-- - tracking_rate_limits: the bucket check gains 'checkout-client:<64 hex>' (per-client checkout limit). The DROP and ADD of
--   the check only widen it: every existing row stays valid.
-- No existing table gains a column, so code from before this migration keeps working against the new schema.
CREATE TABLE "customer_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "customer_accounts_provider_valid" CHECK ("customer_accounts"."provider_id" = 'google'),
	CONSTRAINT "customer_accounts_no_secrets" CHECK ("customer_accounts"."access_token" is null and "customer_accounts"."refresh_token" is null and "customer_accounts"."id_token" is null and "customer_accounts"."password" is null)
);
--> statement-breakpoint
CREATE TABLE "customer_orders" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"customer_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_rate_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "customer_rate_limits_key_key" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "customer_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	CONSTRAINT "customer_sessions_token_key" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "customer_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_users_email_key" UNIQUE("email"),
	CONSTRAINT "customer_users_email_lowercase" CHECK ("customer_users"."email" = lower("customer_users"."email"))
);
--> statement-breakpoint
CREATE TABLE "customer_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_publications" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "policy_publications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"event" text NOT NULL,
	"draft_version" integer,
	"body_en" text,
	"body_bn" text,
	"body_en_sha256" text,
	"body_bn_sha256" text,
	"actor_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_publications_kind_valid" CHECK ("policy_publications"."kind" in ('delivery', 'returns', 'privacy', 'checkout_notices')),
	CONSTRAINT "policy_publications_event_valid" CHECK ("policy_publications"."event" in ('published', 'withdrawn')),
	CONSTRAINT "policy_publications_content_consistent" CHECK (case when "policy_publications"."event" = 'published' then "policy_publications"."draft_version" >= 1 and btrim("policy_publications"."body_en") <> '' and btrim("policy_publications"."body_bn") <> '' and length("policy_publications"."body_en") <= 20000 and length("policy_publications"."body_bn") <= 20000 and "policy_publications"."body_en_sha256" ~ '^[0-9a-f]{64}$' and "policy_publications"."body_bn_sha256" ~ '^[0-9a-f]{64}$' else "policy_publications"."draft_version" is null and "policy_publications"."body_en" is null and "policy_publications"."body_bn" is null and "policy_publications"."body_en_sha256" is null and "policy_publications"."body_bn_sha256" is null end)
);
--> statement-breakpoint
ALTER TABLE "tracking_rate_limits" DROP CONSTRAINT "tracking_rate_limits_bucket_valid";--> statement-breakpoint
ALTER TABLE "customer_accounts" ADD CONSTRAINT "customer_accounts_user_id_customer_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."customer_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_customer_user_id_customer_users_id_fk" FOREIGN KEY ("customer_user_id") REFERENCES "public"."customer_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_sessions" ADD CONSTRAINT "customer_sessions_user_id_customer_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."customer_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_publications" ADD CONSTRAINT "policy_publications_actor_user_id_auth_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_accounts_user_id_idx" ON "customer_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_accounts_provider_account_key" ON "customer_accounts" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "customer_orders_customer_user_id_idx" ON "customer_orders" USING btree ("customer_user_id","created_at");--> statement-breakpoint
CREATE INDEX "customer_sessions_user_id_idx" ON "customer_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "customer_verifications_identifier_idx" ON "customer_verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "policy_publications_kind_id_idx" ON "policy_publications" USING btree ("kind","id");--> statement-breakpoint
ALTER TABLE "tracking_rate_limits" ADD CONSTRAINT "tracking_rate_limits_bucket_valid" CHECK ("tracking_rate_limits"."bucket" in ('failure', 'checkout') or "tracking_rate_limits"."bucket" ~ '^link:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or "tracking_rate_limits"."bucket" ~ '^checkout-client:[0-9a-f]{64}$');--> statement-breakpoint
CREATE TRIGGER "policy_publications_append_only"
BEFORE UPDATE OR DELETE OR TRUNCATE ON "policy_publications"
FOR EACH STATEMENT EXECUTE FUNCTION "append_only_reject_change"();
