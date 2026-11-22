-- Manual advance payments (ADR-0013). Reviewed by hand. Additive in effect:
-- - payment_methods: the Owner's bKash, Nagad and bank receiving details; no row exists until the Owner saves one, and
--   a method is offered only when enabled with complete details and the Owner's approval.
-- - advance_payments: customer-submitted or Owner-recorded transfer references and the Owner's verification of each.
-- - orders: payment_method (default 'cod', so every existing order stays cash on delivery), advance_received_paisa and
--   advance_refunded_paisa (default 0). The money and payment-status checks are re-created to count verified advance
--   money; for every existing row (advance 0) they give exactly the old result.
-- - payment_entries: the kind and refund checks also allow the three advance kinds. Every existing row stays valid.
-- The DROP/ADD pairs only widen checks. No existing row, trigger or function changes.
CREATE TABLE "advance_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"method" text NOT NULL,
	"reference" text NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"amount_paisa" bigint,
	"received_on" date,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" uuid,
	"payment_entry_id" bigint,
	"reversal_entry_id" bigint,
	CONSTRAINT "advance_payments_method_valid" CHECK ("advance_payments"."method" in ('bkash', 'nagad', 'bank_transfer')),
	CONSTRAINT "advance_payments_reference_format" CHECK ("advance_payments"."reference" ~ '^[A-Z0-9][A-Z0-9/-]{3,39}$'),
	CONSTRAINT "advance_payments_source_valid" CHECK ("advance_payments"."source" in ('customer', 'owner')),
	CONSTRAINT "advance_payments_status_valid" CHECK ("advance_payments"."status" in ('submitted', 'verified', 'rejected', 'reversed')),
	CONSTRAINT "advance_payments_note_valid" CHECK (btrim("advance_payments"."note") <> '' and length("advance_payments"."note") <= 300),
	CONSTRAINT "advance_payments_decision_consistent" CHECK (("advance_payments"."status" = 'submitted') = ("advance_payments"."decided_at" is null) and ("advance_payments"."decided_at" is null) = ("advance_payments"."decided_by_user_id" is null)
        and ("advance_payments"."status" in ('verified', 'reversed')) = ("advance_payments"."payment_entry_id" is not null)
        and ("advance_payments"."status" in ('verified', 'reversed')) = ("advance_payments"."amount_paisa" is not null and "advance_payments"."received_on" is not null)
        and ("advance_payments"."status" = 'reversed') = ("advance_payments"."reversal_entry_id" is not null)
        and ("advance_payments"."source" = 'customer' or "advance_payments"."status" <> 'submitted')),
	CONSTRAINT "advance_payments_amount_valid" CHECK ("advance_payments"."amount_paisa" > 0 and "advance_payments"."amount_paisa" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "payment_methods" (
	"method" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"account_name" text,
	"account_number" text,
	"account_kind" text,
	"bank_name" text,
	"branch_name" text,
	"routing_number" text,
	"instructions_en" text,
	"instructions_bn" text,
	"approved_at" timestamp with time zone,
	"approved_by_user_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid NOT NULL,
	CONSTRAINT "payment_methods_method_valid" CHECK ("payment_methods"."method" in ('bkash', 'nagad', 'bank_transfer')),
	CONSTRAINT "payment_methods_kind_valid" CHECK ("payment_methods"."account_kind" in ('merchant', 'personal')),
	CONSTRAINT "payment_methods_texts_valid" CHECK (coalesce(length("payment_methods"."account_name"), 1) between 1 and 80 and coalesce(length("payment_methods"."account_number"), 6) between 6 and 34 and coalesce(length("payment_methods"."bank_name"), 1) between 1 and 80 and coalesce(length("payment_methods"."branch_name"), 1) between 1 and 80 and ("payment_methods"."routing_number" is null or "payment_methods"."routing_number" ~ '^[0-9]{9}$') and coalesce(length("payment_methods"."instructions_en"), 0) <= 300 and coalesce(length("payment_methods"."instructions_bn"), 0) <= 300),
	CONSTRAINT "payment_methods_enabled_complete" CHECK (not "payment_methods"."enabled" or ("payment_methods"."account_name" is not null and "payment_methods"."account_number" is not null and "payment_methods"."approved_at" is not null and "payment_methods"."approved_by_user_id" is not null
        and ("payment_methods"."method" = 'bank_transfer') = ("payment_methods"."bank_name" is not null)
        and ("payment_methods"."method" = 'bank_transfer') = ("payment_methods"."account_kind" is null))),
	CONSTRAINT "payment_methods_wallet_number" CHECK ("payment_methods"."method" = 'bank_transfer' or "payment_methods"."account_number" is null or "payment_methods"."account_number" ~ '^01[3-9][0-9]{8}$'),
	CONSTRAINT "payment_methods_version_positive" CHECK ("payment_methods"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_cod_amounts_valid";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_payment_status_derived";--> statement-breakpoint
ALTER TABLE "payment_entries" DROP CONSTRAINT "payment_entries_kind_valid";--> statement-breakpoint
ALTER TABLE "payment_entries" DROP CONSTRAINT "payment_entries_refund_consistent";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_method" text DEFAULT 'cod' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "advance_received_paisa" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "advance_refunded_paisa" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "advance_payments" ADD CONSTRAINT "advance_payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advance_payments" ADD CONSTRAINT "advance_payments_decided_by_user_id_auth_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advance_payments" ADD CONSTRAINT "advance_payments_payment_entry_id_payment_entries_id_fk" FOREIGN KEY ("payment_entry_id") REFERENCES "public"."payment_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advance_payments" ADD CONSTRAINT "advance_payments_reversal_entry_id_payment_entries_id_fk" FOREIGN KEY ("reversal_entry_id") REFERENCES "public"."payment_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_approved_by_user_id_auth_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_updated_by_user_id_auth_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "advance_payments_order_id_idx" ON "advance_payments" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "advance_payments_submitted_idx" ON "advance_payments" USING btree ("created_at") WHERE "advance_payments"."status" = 'submitted';--> statement-breakpoint
CREATE UNIQUE INDEX "advance_payments_verified_reference_key" ON "advance_payments" USING btree ("method","reference") WHERE "advance_payments"."status" = 'verified';--> statement-breakpoint
CREATE UNIQUE INDEX "advance_payments_open_reference_key" ON "advance_payments" USING btree ("order_id","method","reference") WHERE "advance_payments"."status" = 'submitted';--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_advance_amounts_valid" CHECK ("orders"."payment_method" in ('cod', 'bkash', 'nagad', 'bank_transfer') and "orders"."advance_received_paisa" >= 0 and "orders"."advance_refunded_paisa" >= 0 and "orders"."advance_refunded_paisa" <= "orders"."advance_received_paisa" and ("orders"."payment_method" <> 'cod' or ("orders"."advance_received_paisa" = 0 and "orders"."advance_refunded_paisa" = 0)));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_cod_amounts_valid" CHECK ("orders"."cod_settled_paisa" >= 0 and "orders"."cod_deducted_paisa" >= 0 and "orders"."cod_settled_paisa" + "orders"."cod_deducted_paisa" <= "orders"."cod_collected_paisa" and "orders"."cod_collected_paisa" + "orders"."advance_received_paisa" <= "orders"."total_paisa" and "orders"."refunded_paisa" >= 0 and "orders"."refunded_paisa" + "orders"."advance_refunded_paisa" <= "orders"."cod_collected_paisa" + "orders"."advance_received_paisa");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_payment_status_derived" CHECK ("orders"."payment_status" = case when "orders"."cod_collected_paisa" + "orders"."advance_received_paisa" = 0 then 'unpaid' when "orders"."cod_collected_paisa" + "orders"."advance_received_paisa" < "orders"."total_paisa" then 'partially_collected' when "orders"."cod_settled_paisa" + "orders"."cod_deducted_paisa" < "orders"."cod_collected_paisa" then 'collected' else 'settled' end);--> statement-breakpoint
ALTER TABLE "payment_entries" ADD CONSTRAINT "payment_entries_kind_valid" CHECK ("payment_entries"."kind" in ('collected', 'settled', 'deducted', 'refunded', 'advance_received', 'advance_reversed', 'advance_refunded'));--> statement-breakpoint
ALTER TABLE "payment_entries" ADD CONSTRAINT "payment_entries_refund_consistent" CHECK (("payment_entries"."kind" in ('refunded', 'advance_received', 'advance_reversed', 'advance_refunded')) = ("payment_entries"."method" is not null) and ("payment_entries"."kind" = 'refunded') = ("payment_entries"."return_id" is not null));