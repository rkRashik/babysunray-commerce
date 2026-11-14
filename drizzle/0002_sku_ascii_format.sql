ALTER TABLE "variants" DROP CONSTRAINT "variants_sku_canonical";--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_sku_canonical" CHECK ("variants"."sku" ~ '^[A-Z0-9_-]{1,64}$');