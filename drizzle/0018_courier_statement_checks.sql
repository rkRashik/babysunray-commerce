-- Gate H.41: an append-only record of courier statement checks (read-only matching of a statement against the
-- recorded COD money; nothing is settled from it). Reviewed by hand. Additive: one new table and its append-only
-- trigger (append_only_reject_change() from migration 0008); no existing table or row is changed.
CREATE TABLE "courier_statement_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"file_sha256" text NOT NULL,
	"row_count" integer NOT NULL,
	"matches" integer NOT NULL,
	"differs" integer NOT NULL,
	"not_found" integer NOT NULL,
	"duplicates" integer NOT NULL,
	"invalid" integer NOT NULL,
	"report" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "courier_statement_checks_sha256_format" CHECK ("courier_statement_checks"."file_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "courier_statement_checks_counts_valid" CHECK ("courier_statement_checks"."matches" >= 0 and "courier_statement_checks"."differs" >= 0 and "courier_statement_checks"."not_found" >= 0 and "courier_statement_checks"."duplicates" >= 0 and "courier_statement_checks"."invalid" >= 0 and "courier_statement_checks"."row_count" = "courier_statement_checks"."matches" + "courier_statement_checks"."differs" + "courier_statement_checks"."not_found" + "courier_statement_checks"."duplicates" + "courier_statement_checks"."invalid"),
	CONSTRAINT "courier_statement_checks_report_object" CHECK (jsonb_typeof("courier_statement_checks"."report") = 'object')
);
--> statement-breakpoint
ALTER TABLE "courier_statement_checks" ADD CONSTRAINT "courier_statement_checks_actor_user_id_auth_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "courier_statement_checks_created_at_idx" ON "courier_statement_checks" USING btree ("created_at");--> statement-breakpoint
CREATE TRIGGER "courier_statement_checks_append_only"
BEFORE UPDATE OR DELETE OR TRUNCATE ON "courier_statement_checks"
FOR EACH STATEMENT EXECUTE FUNCTION "append_only_reject_change"();
