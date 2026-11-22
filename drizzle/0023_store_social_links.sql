ALTER TABLE "store_settings" ADD COLUMN "social_facebook" text;--> statement-breakpoint
ALTER TABLE "store_settings" ADD COLUMN "social_instagram" text;--> statement-breakpoint
ALTER TABLE "store_settings" ADD CONSTRAINT "store_settings_social_valid" CHECK (coalesce(length("store_settings"."social_facebook"), 0) <= 200 and coalesce(length("store_settings"."social_instagram"), 0) <= 200);