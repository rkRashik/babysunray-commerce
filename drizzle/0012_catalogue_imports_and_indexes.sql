-- Gate H.21: an append-only audit of bulk catalogue imports, and two indexes for the Office product list
-- (measured on 5,000 fictional products). Reviewed by hand. Additive only. The trigger reuses the existing
-- append_only_reject_change() function (migration 0008), like export_requests.
CREATE TABLE "catalogue_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"format" text NOT NULL,
	"file_sha256" text NOT NULL,
	"products_created" integer NOT NULL,
	"variants_created" integer NOT NULL,
	"product_ids" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalogue_imports_format_valid" CHECK ("catalogue_imports"."format" in ('csv', 'xlsx')),
	CONSTRAINT "catalogue_imports_sha256_format" CHECK ("catalogue_imports"."file_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "catalogue_imports_counts_valid" CHECK ("catalogue_imports"."products_created" >= 1 and "catalogue_imports"."variants_created" >= "catalogue_imports"."products_created"),
	CONSTRAINT "catalogue_imports_product_ids_array" CHECK (jsonb_typeof("catalogue_imports"."product_ids") = 'array' and jsonb_array_length("catalogue_imports"."product_ids") = "catalogue_imports"."products_created")
);
--> statement-breakpoint
ALTER TABLE "catalogue_imports" ADD CONSTRAINT "catalogue_imports_actor_user_id_auth_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalogue_imports_created_at_idx" ON "catalogue_imports" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "products_created_at_id_idx" ON "products" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "products_category_id_idx" ON "products" USING btree ("category_id");--> statement-breakpoint
CREATE TRIGGER "catalogue_imports_append_only"
BEFORE UPDATE OR DELETE OR TRUNCATE ON "catalogue_imports"
FOR EACH STATEMENT EXECUTE FUNCTION "append_only_reject_change"();
