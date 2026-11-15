-- Owner operations: export audit and physical stock counts (requirements D-6, I-8, OF-6). Additive only: three
-- new tables, nothing existing is changed. export_requests is append-only, like order_events (same function).
CREATE TABLE "export_requests" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "export_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_user_id" uuid NOT NULL,
	"dataset" text NOT NULL,
	"format" text NOT NULL,
	"scope" text NOT NULL,
	"filters" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "export_requests_dataset_valid" CHECK ("export_requests"."dataset" ~ '^[a-z][a-z_]{1,49}$'),
	CONSTRAINT "export_requests_format_valid" CHECK ("export_requests"."format" in ('xlsx', 'csv', 'json')),
	CONSTRAINT "export_requests_scope_valid" CHECK ("export_requests"."scope" in ('complete', 'filtered')),
	CONSTRAINT "export_requests_filters_object" CHECK (jsonb_typeof("export_requests"."filters") = 'object')
);
--> statement-breakpoint
CREATE TABLE "stock_count_lines" (
	"count_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"snapshot_on_hand" integer NOT NULL,
	"snapshot_reserved" integer NOT NULL,
	"counted" integer,
	"counted_at" timestamp with time zone,
	"basis_on_hand" integer,
	"basis_movement_id" bigint,
	"applied_delta" integer,
	"movement_id" bigint,
	CONSTRAINT "stock_count_lines_pkey" PRIMARY KEY("count_id","variant_id"),
	CONSTRAINT "stock_count_lines_movement_key" UNIQUE("movement_id"),
	CONSTRAINT "stock_count_lines_snapshot_valid" CHECK ("stock_count_lines"."snapshot_on_hand" >= 0 and "stock_count_lines"."snapshot_reserved" >= 0 and "stock_count_lines"."snapshot_reserved" <= "stock_count_lines"."snapshot_on_hand"),
	CONSTRAINT "stock_count_lines_count_consistent" CHECK (("stock_count_lines"."counted" is null) = ("stock_count_lines"."counted_at" is null) and ("stock_count_lines"."counted" is null) = ("stock_count_lines"."basis_on_hand" is null) and ("stock_count_lines"."counted" is null) = ("stock_count_lines"."basis_movement_id" is null)),
	CONSTRAINT "stock_count_lines_counted_valid" CHECK ("stock_count_lines"."counted" >= 0 and "stock_count_lines"."basis_on_hand" >= 0 and "stock_count_lines"."basis_movement_id" >= 0),
	CONSTRAINT "stock_count_lines_applied_consistent" CHECK ("stock_count_lines"."movement_id" is null or ("stock_count_lines"."applied_delta" is not null and "stock_count_lines"."applied_delta" <> 0))
);
--> statement-breakpoint
CREATE TABLE "stock_counts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" bigint GENERATED ALWAYS AS IDENTITY (sequence name "stock_counts_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"status" text NOT NULL,
	"scope" text NOT NULL,
	"reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by_user_id" uuid,
	CONSTRAINT "stock_counts_number_key" UNIQUE("number"),
	CONSTRAINT "stock_counts_status_valid" CHECK ("stock_counts"."status" in ('draft', 'applied', 'discarded')),
	CONSTRAINT "stock_counts_scope_valid" CHECK ("stock_counts"."scope" in ('all', 'selected')),
	CONSTRAINT "stock_counts_reason_valid" CHECK (btrim("stock_counts"."reason") <> '' and length("stock_counts"."reason") <= 400),
	CONSTRAINT "stock_counts_version_positive" CHECK ("stock_counts"."version" >= 1),
	CONSTRAINT "stock_counts_close_consistent" CHECK (("stock_counts"."status" = 'draft') = ("stock_counts"."closed_at" is null) and ("stock_counts"."closed_at" is null) = ("stock_counts"."closed_by_user_id" is null))
);
--> statement-breakpoint
ALTER TABLE "export_requests" ADD CONSTRAINT "export_requests_actor_user_id_auth_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_count_id_stock_counts_id_fk" FOREIGN KEY ("count_id") REFERENCES "public"."stock_counts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_movement_id_stock_movements_id_fk" FOREIGN KEY ("movement_id") REFERENCES "public"."stock_movements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_created_by_user_id_auth_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_closed_by_user_id_auth_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "export_requests_created_at_idx" ON "export_requests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "stock_counts_created_at_idx" ON "stock_counts" USING btree ("created_at");--> statement-breakpoint
CREATE TRIGGER "export_requests_append_only"
BEFORE UPDATE OR DELETE OR TRUNCATE ON "export_requests"
FOR EACH STATEMENT EXECUTE FUNCTION "append_only_reject_change"();
