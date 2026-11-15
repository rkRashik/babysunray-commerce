-- Gate H.18: product categories, structured bilingual content, measurements in millimetres and the media manifest
-- (product photos are files in the configured media storage; only their metadata is here). Reviewed by hand.
-- Additive only: three new tables and nullable product columns (featured defaults to false). Nothing is published.
CREATE TABLE "product_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name_en" text,
	"name_bn" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_categories_slug_key" UNIQUE("slug"),
	CONSTRAINT "product_categories_version_positive" CHECK ("product_categories"."version" >= 1),
	CONSTRAINT "product_categories_slug_format" CHECK ("product_categories"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length("product_categories"."slug") <= 100),
	CONSTRAINT "product_categories_name_present" CHECK ("product_categories"."name_en" is not null or "product_categories"."name_bn" is not null),
	CONSTRAINT "product_categories_names_valid" CHECK (btrim("product_categories"."name_en") <> '' and length("product_categories"."name_en") <= 100 and btrim("product_categories"."name_bn") <> '' and length("product_categories"."name_bn") <= 100)
);
--> statement-breakpoint
CREATE TABLE "product_measurements" (
	"product_id" uuid NOT NULL,
	"size" text NOT NULL,
	"point" text NOT NULL,
	"value_mm" integer NOT NULL,
	CONSTRAINT "product_measurements_pkey" PRIMARY KEY("product_id","size","point"),
	CONSTRAINT "product_measurements_size_valid" CHECK (btrim("product_measurements"."size") <> '' and length("product_measurements"."size") <= 64),
	CONSTRAINT "product_measurements_point_valid" CHECK ("product_measurements"."point" in ('chest', 'waist', 'hip', 'length', 'shoulder', 'sleeve', 'inseam', 'foot')),
	CONSTRAINT "product_measurements_value_range" CHECK ("product_measurements"."value_mm" between 1 and 3000)
);
--> statement-breakpoint
CREATE TABLE "product_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"sha256" text NOT NULL,
	"alt_en" text,
	"alt_bn" text,
	"position" integer NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_media_storage_key_key" UNIQUE("storage_key"),
	CONSTRAINT "product_media_storage_key_format" CHECK ("product_media"."storage_key" ~ '^[0-9a-f]{32}[.](jpg|png|webp)$'),
	CONSTRAINT "product_media_content_type_valid" CHECK ("product_media"."content_type" in ('image/jpeg', 'image/png', 'image/webp')),
	CONSTRAINT "product_media_byte_size_range" CHECK ("product_media"."byte_size" between 1 and 20971520),
	CONSTRAINT "product_media_dimensions_range" CHECK ("product_media"."width" between 1 and 10000 and "product_media"."height" between 1 and 10000),
	CONSTRAINT "product_media_sha256_format" CHECK ("product_media"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "product_media_alt_valid" CHECK (btrim("product_media"."alt_en") <> '' and length("product_media"."alt_en") <= 300 and btrim("product_media"."alt_bn") <> '' and length("product_media"."alt_bn") <= 300),
	CONSTRAINT "product_media_position_nonnegative" CHECK ("product_media"."position" >= 0)
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "category_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "fabric_en" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "fabric_bn" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "fabric_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "fabric_confirmed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "care_en" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "care_bn" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "size_guidance_en" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "size_guidance_bn" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "featured" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "product_measurements" ADD CONSTRAINT "product_measurements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_created_by_user_id_auth_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_media_product_position_idx" ON "product_media" USING btree ("product_id","position");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_product_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_fabric_confirmed_by_user_id_auth_users_id_fk" FOREIGN KEY ("fabric_confirmed_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_content_valid" CHECK (btrim("products"."fabric_en") <> '' and length("products"."fabric_en") <= 1000 and btrim("products"."fabric_bn") <> '' and length("products"."fabric_bn") <= 1000
        and btrim("products"."care_en") <> '' and length("products"."care_en") <= 1000 and btrim("products"."care_bn") <> '' and length("products"."care_bn") <= 1000
        and btrim("products"."size_guidance_en") <> '' and length("products"."size_guidance_en") <= 1000 and btrim("products"."size_guidance_bn") <> '' and length("products"."size_guidance_bn") <= 1000);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_fabric_confirmation_consistent" CHECK (("products"."fabric_confirmed_at" is null) = ("products"."fabric_confirmed_by_user_id" is null) and ("products"."fabric_confirmed_at" is null or "products"."fabric_en" is not null or "products"."fabric_bn" is not null));