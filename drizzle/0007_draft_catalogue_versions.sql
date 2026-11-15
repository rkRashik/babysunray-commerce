ALTER TABLE "products" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "variants" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_version_positive" CHECK ("products"."version" >= 1);--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_version_positive" CHECK ("variants"."version" >= 1);