-- Gate H.25-H.28: anonymous checkout submissions (inactive: no route uses them), append-only internal product
-- reviews, private policy drafts and their append-only audit. Reviewed by hand. Additive only: no existing
-- table, column, constraint or row is changed. The append-only triggers reuse append_only_reject_change()
-- (migration 0008); guest_checkout_submissions gets its own guard (a row may only gain its order once).
CREATE TABLE "guest_checkout_submissions" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"request_mac" text NOT NULL,
	"order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guest_checkout_submissions_order_id_key" UNIQUE("order_id"),
	CONSTRAINT "guest_checkout_submissions_key_hash_format" CHECK ("guest_checkout_submissions"."key_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "guest_checkout_submissions_request_mac_format" CHECK ("guest_checkout_submissions"."request_mac" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "policy_draft_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "policy_draft_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"event" text NOT NULL,
	"version" integer NOT NULL,
	"body_en_sha256" text,
	"body_bn_sha256" text,
	"actor_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_draft_events_kind_valid" CHECK ("policy_draft_events"."kind" in ('delivery', 'returns', 'privacy', 'checkout_notices')),
	CONSTRAINT "policy_draft_events_event_valid" CHECK ("policy_draft_events"."event" in ('saved', 'marked_reviewed')),
	CONSTRAINT "policy_draft_events_version_positive" CHECK ("policy_draft_events"."version" >= 1),
	CONSTRAINT "policy_draft_events_sha256_format" CHECK ("policy_draft_events"."body_en_sha256" ~ '^[0-9a-f]{64}$' and "policy_draft_events"."body_bn_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "policy_drafts" (
	"kind" text PRIMARY KEY NOT NULL,
	"body_en" text,
	"body_bn" text,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by_user_id" uuid,
	CONSTRAINT "policy_drafts_kind_valid" CHECK ("policy_drafts"."kind" in ('delivery', 'returns', 'privacy', 'checkout_notices')),
	CONSTRAINT "policy_drafts_version_positive" CHECK ("policy_drafts"."version" >= 1),
	CONSTRAINT "policy_drafts_bodies_valid" CHECK (btrim("policy_drafts"."body_en") <> '' and length("policy_drafts"."body_en") <= 20000 and btrim("policy_drafts"."body_bn") <> '' and length("policy_drafts"."body_bn") <= 20000),
	CONSTRAINT "policy_drafts_review_consistent" CHECK (("policy_drafts"."reviewed_at" is null) = ("policy_drafts"."reviewed_by_user_id" is null) and ("policy_drafts"."reviewed_at" is null or ("policy_drafts"."body_en" is not null and "policy_drafts"."body_bn" is not null)))
);
--> statement-breakpoint
CREATE TABLE "product_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"content_sha256" text NOT NULL,
	"open_items" jsonb NOT NULL,
	"reviewed_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_reviews_content_sha256_format" CHECK ("product_reviews"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "product_reviews_open_items_array" CHECK (jsonb_typeof("product_reviews"."open_items") = 'array')
);
--> statement-breakpoint
ALTER TABLE "guest_checkout_submissions" ADD CONSTRAINT "guest_checkout_submissions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_draft_events" ADD CONSTRAINT "policy_draft_events_actor_user_id_auth_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_drafts" ADD CONSTRAINT "policy_drafts_updated_by_user_id_auth_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_drafts" ADD CONSTRAINT "policy_drafts_reviewed_by_user_id_auth_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_reviewed_by_user_id_auth_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "policy_draft_events_kind_id_idx" ON "policy_draft_events" USING btree ("kind","id");--> statement-breakpoint
CREATE INDEX "product_reviews_product_id_created_at_idx" ON "product_reviews" USING btree ("product_id","created_at");--> statement-breakpoint
CREATE TRIGGER "product_reviews_append_only"
BEFORE UPDATE OR DELETE OR TRUNCATE ON "product_reviews"
FOR EACH STATEMENT EXECUTE FUNCTION "append_only_reject_change"();
--> statement-breakpoint
CREATE TRIGGER "policy_draft_events_append_only"
BEFORE UPDATE OR DELETE OR TRUNCATE ON "policy_draft_events"
FOR EACH STATEMENT EXECUTE FUNCTION "append_only_reject_change"();
--> statement-breakpoint
CREATE FUNCTION "guest_checkout_submissions_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.order_id IS NULL AND NEW.order_id IS NOT NULL
     AND NEW.key_hash = OLD.key_hash AND NEW.request_mac = OLD.request_mac AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'guest_checkout_submissions: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "guest_checkout_submissions_guard"
BEFORE UPDATE OR DELETE ON "guest_checkout_submissions"
FOR EACH ROW EXECUTE FUNCTION "guest_checkout_submissions_guard"();
--> statement-breakpoint
CREATE TRIGGER "guest_checkout_submissions_no_truncate"
BEFORE TRUNCATE ON "guest_checkout_submissions"
FOR EACH STATEMENT EXECUTE FUNCTION "append_only_reject_change"();
