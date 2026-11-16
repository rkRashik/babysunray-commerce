-- Gate H.32: the publication foundation. Reviewed by hand. A product may now be 'published' (no code path can set it
-- while no publication rule, requirement I-6, is approved), and every publication decision is recorded in an
-- append-only table (trigger reuses append_only_reject_change() from migration 0008). Every existing row stays
-- valid: the status check only gains a value; no product is changed.
CREATE TABLE "product_publication_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "product_publication_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"product_id" uuid NOT NULL,
	"event" text NOT NULL,
	"content_sha256" text NOT NULL,
	"rule_id" text,
	"actor_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_publication_events_event_valid" CHECK ("product_publication_events"."event" in ('published', 'withdrawn')),
	CONSTRAINT "product_publication_events_content_sha256_format" CHECK ("product_publication_events"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "product_publication_events_rule_consistent" CHECK (("product_publication_events"."event" = 'published') = ("product_publication_events"."rule_id" is not null) and ("product_publication_events"."rule_id" is null or "product_publication_events"."rule_id" ~ '^[a-z0-9][a-z0-9.-]{0,63}$'))
);
--> statement-breakpoint
ALTER TABLE "products" DROP CONSTRAINT "products_status_valid";--> statement-breakpoint
ALTER TABLE "product_publication_events" ADD CONSTRAINT "product_publication_events_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_publication_events" ADD CONSTRAINT "product_publication_events_actor_user_id_auth_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_publication_events_product_id_id_idx" ON "product_publication_events" USING btree ("product_id","id");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_status_valid" CHECK ("products"."status" in ('draft', 'published', 'archived'));--> statement-breakpoint
CREATE TRIGGER "product_publication_events_append_only"
BEFORE UPDATE OR DELETE OR TRUNCATE ON "product_publication_events"
FOR EACH STATEMENT EXECUTE FUNCTION "append_only_reject_change"();
