-- Store setup and customer accounts (ADR-0012). Reviewed by hand. Additive in effect:
-- - store_settings: one row of Owner-edited store identity, contact channels, logo and the approved publication rule.
-- - owner_recovery_codes: hashed one-time recovery codes for the Owner.
-- - customer_accounts: the provider check now also allows 'credential' (email and password); OAuth tokens stay forbidden,
--   and a password hash is allowed only on the credential account. Every existing row (Google, no secrets) stays valid.
-- - tracking_rate_limits: the bucket check gains 'admin-setup' and 'admin-recovery'. Every existing row stays valid.
-- The DROP/ADD pairs only widen checks. No existing column changes.
CREATE TABLE "owner_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_sha256" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_recovery_codes_code_sha256_key" UNIQUE("code_sha256"),
	CONSTRAINT "owner_recovery_codes_sha256_format" CHECK ("owner_recovery_codes"."code_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "store_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"store_name" text,
	"line_en" text,
	"line_bn" text,
	"contact_phone" text,
	"contact_email" text,
	"contact_whatsapp" text,
	"contact_messenger" text,
	"logo_base64" text,
	"logo_content_type" text,
	"logo_width" integer,
	"logo_height" integer,
	"logo_sha256" text,
	"rule_items" jsonb,
	"rule_approved_at" timestamp with time zone,
	"rule_approved_by_user_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "store_settings_single_row" CHECK ("store_settings"."id" = 1),
	CONSTRAINT "store_settings_version_positive" CHECK ("store_settings"."version" >= 1),
	CONSTRAINT "store_settings_texts_valid" CHECK (coalesce(length("store_settings"."store_name"), 1) between 1 and 60 and coalesce(length("store_settings"."line_en"), 0) <= 200 and coalesce(length("store_settings"."line_bn"), 0) <= 200 and coalesce(length("store_settings"."contact_phone"), 0) <= 30 and coalesce(length("store_settings"."contact_email"), 0) <= 120 and coalesce(length("store_settings"."contact_whatsapp"), 0) <= 30 and coalesce(length("store_settings"."contact_messenger"), 0) <= 200),
	CONSTRAINT "store_settings_logo_consistent" CHECK (("store_settings"."logo_base64" is null) = ("store_settings"."logo_sha256" is null) and ("store_settings"."logo_base64" is null) = ("store_settings"."logo_width" is null) and ("store_settings"."logo_base64" is null) = ("store_settings"."logo_content_type" is null) and coalesce(length("store_settings"."logo_base64"), 0) <= 700000 and ("store_settings"."logo_content_type" is null or "store_settings"."logo_content_type" in ('image/png', 'image/jpeg', 'image/webp'))),
	CONSTRAINT "store_settings_rule_consistent" CHECK (("store_settings"."rule_approved_at" is null) = ("store_settings"."rule_approved_by_user_id" is null) and ("store_settings"."rule_approved_at" is null or "store_settings"."rule_items" is not null))
);
--> statement-breakpoint
ALTER TABLE "customer_accounts" DROP CONSTRAINT "customer_accounts_provider_valid";--> statement-breakpoint
ALTER TABLE "customer_accounts" DROP CONSTRAINT "customer_accounts_no_secrets";--> statement-breakpoint
ALTER TABLE "tracking_rate_limits" DROP CONSTRAINT "tracking_rate_limits_bucket_valid";--> statement-breakpoint
ALTER TABLE "owner_recovery_codes" ADD CONSTRAINT "owner_recovery_codes_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_settings" ADD CONSTRAINT "store_settings_rule_approved_by_user_id_auth_users_id_fk" FOREIGN KEY ("rule_approved_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_settings" ADD CONSTRAINT "store_settings_updated_by_user_id_auth_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "owner_recovery_codes_user_id_idx" ON "owner_recovery_codes" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "customer_accounts" ADD CONSTRAINT "customer_accounts_provider_valid" CHECK ("customer_accounts"."provider_id" in ('google', 'credential'));--> statement-breakpoint
ALTER TABLE "customer_accounts" ADD CONSTRAINT "customer_accounts_no_secrets" CHECK ("customer_accounts"."access_token" is null and "customer_accounts"."refresh_token" is null and "customer_accounts"."id_token" is null and ("customer_accounts"."password" is null or "customer_accounts"."provider_id" = 'credential'));--> statement-breakpoint
ALTER TABLE "tracking_rate_limits" ADD CONSTRAINT "tracking_rate_limits_bucket_valid" CHECK ("tracking_rate_limits"."bucket" in ('failure', 'checkout', 'admin-setup', 'admin-recovery') or "tracking_rate_limits"."bucket" ~ '^link:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or "tracking_rate_limits"."bucket" ~ '^checkout-client:[0-9a-f]{64}$');