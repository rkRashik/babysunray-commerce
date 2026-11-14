CREATE TABLE "inventory_balances" (
	"variant_id" uuid PRIMARY KEY NOT NULL,
	"on_hand" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_balances_on_hand_nonnegative" CHECK ("inventory_balances"."on_hand" >= 0)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name_en" text,
	"name_bn" text,
	"description_en" text,
	"description_bn" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_slug_key" UNIQUE("slug"),
	CONSTRAINT "products_slug_format" CHECK ("products"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length("products"."slug") <= 100),
	CONSTRAINT "products_status_valid" CHECK ("products"."status" in ('draft', 'archived')),
	CONSTRAINT "products_name_present" CHECK ("products"."name_en" is not null or "products"."name_bn" is not null),
	CONSTRAINT "products_names_valid" CHECK (btrim("products"."name_en") <> '' and length("products"."name_en") <= 200 and btrim("products"."name_bn") <> '' and length("products"."name_bn") <= 200),
	CONSTRAINT "products_descriptions_valid" CHECK (btrim("products"."description_en") <> '' and length("products"."description_en") <= 5000 and btrim("products"."description_bn") <> '' and length("products"."description_bn") <= 5000)
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "stock_movements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"variant_id" uuid NOT NULL,
	"movement_type" text NOT NULL,
	"quantity_delta" integer NOT NULL,
	"reason" text,
	"actor_type" text NOT NULL,
	"actor_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movements_type_valid" CHECK ("stock_movements"."movement_type" in ('receipt', 'adjustment')),
	CONSTRAINT "stock_movements_delta_valid" CHECK ("stock_movements"."quantity_delta" <> 0 and ("stock_movements"."movement_type" <> 'receipt' or "stock_movements"."quantity_delta" > 0)),
	CONSTRAINT "stock_movements_reason_valid" CHECK (("stock_movements"."movement_type" <> 'adjustment' or "stock_movements"."reason" is not null) and btrim("stock_movements"."reason") <> '' and length("stock_movements"."reason") <= 500),
	CONSTRAINT "stock_movements_actor_type_valid" CHECK ("stock_movements"."actor_type" in ('system')),
	CONSTRAINT "stock_movements_actor_ref_format" CHECK ("stock_movements"."actor_ref" ~ '^[a-z0-9][a-z0-9._:-]{0,99}$')
);
--> statement-breakpoint
CREATE TABLE "variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"size" text,
	"colour" text,
	"price_paisa" bigint NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variants_sku_key" UNIQUE("sku"),
	CONSTRAINT "variants_sku_canonical" CHECK ("variants"."sku" = upper(btrim("variants"."sku")) and "variants"."sku" is nfc normalized and "variants"."sku" !~ '[[:cntrl:]]' and length("variants"."sku") between 1 and 64),
	CONSTRAINT "variants_labels_valid" CHECK (btrim("variants"."size") <> '' and length("variants"."size") <= 64 and btrim("variants"."colour") <> '' and length("variants"."colour") <= 64),
	CONSTRAINT "variants_price_range" CHECK ("variants"."price_paisa" > 0 and "variants"."price_paisa" <= 9007199254740991),
	CONSTRAINT "variants_status_valid" CHECK ("variants"."status" in ('active', 'inactive'))
);
--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_movements_variant_id_id_idx" ON "stock_movements" USING btree ("variant_id","id");--> statement-breakpoint
CREATE INDEX "variants_product_id_idx" ON "variants" USING btree ("product_id");