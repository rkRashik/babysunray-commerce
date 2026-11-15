-- Orders, reservations, COD, returns, RTO and guest tracking (docs/product/order-policy-decisions.md).
-- Additive only: new tables; inventory_balances.reserved (0 for every existing row) with reserved <= on_hand;
-- stock_movements gains order_id and the dispatch / return_restock types, and its type and delta checks are
-- replaced by supersets in the same transaction, so every existing ledger row stays valid. The ledger trigger is
-- unchanged (adding a column does not update rows).
CREATE TABLE "cancellation_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by_user_id" uuid,
	CONSTRAINT "cancellation_requests_status_valid" CHECK ("cancellation_requests"."status" in ('open', 'approved', 'rejected')),
	CONSTRAINT "cancellation_requests_reason_valid" CHECK (btrim("cancellation_requests"."reason") <> '' and length("cancellation_requests"."reason") <= 500),
	CONSTRAINT "cancellation_requests_review_consistent" CHECK (("cancellation_requests"."status" = 'open') = ("cancellation_requests"."reviewed_at" is null) and ("cancellation_requests"."reviewed_at" is null) = ("cancellation_requests"."reviewed_by_user_id" is null))
);
--> statement-breakpoint
CREATE TABLE "delivery_zones" (
	"code" text PRIMARY KEY NOT NULL,
	"charge_paisa" bigint NOT NULL,
	"active" boolean NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid NOT NULL,
	CONSTRAINT "delivery_zones_code_valid" CHECK ("delivery_zones"."code" in ('dhaka_city', 'outside_dhaka')),
	CONSTRAINT "delivery_zones_charge_range" CHECK ("delivery_zones"."charge_paisa" >= 0 and "delivery_zones"."charge_paisa" <= 1000000),
	CONSTRAINT "delivery_zones_version_positive" CHECK ("delivery_zones"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "order_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"order_id" uuid NOT NULL,
	"event" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_ref" text NOT NULL,
	"actor_user_id" uuid,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_events_event_format" CHECK ("order_events"."event" ~ '^[a-z][a-z_]{1,49}$'),
	CONSTRAINT "order_events_actor_type_valid" CHECK ("order_events"."actor_type" in ('system', 'user', 'customer')),
	CONSTRAINT "order_events_actor_ref_format" CHECK ("order_events"."actor_ref" ~ '^[a-z0-9][a-z0-9._:-]{0,99}$'),
	CONSTRAINT "order_events_actor_user_consistent" CHECK (("order_events"."actor_type" in ('system', 'customer') and "order_events"."actor_user_id" is null) or ("order_events"."actor_type" = 'user' and "order_events"."actor_user_id" is not null and "order_events"."actor_ref" = "order_events"."actor_user_id"::text)),
	CONSTRAINT "order_events_detail_object" CHECK (jsonb_typeof("order_events"."detail") = 'object')
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"product_name_en" text,
	"product_name_bn" text,
	"size" text,
	"colour" text,
	"unit_price_paisa" bigint NOT NULL,
	"quantity" integer NOT NULL,
	"line_total_paisa" bigint NOT NULL,
	CONSTRAINT "order_items_name_present" CHECK ("order_items"."product_name_en" is not null or "order_items"."product_name_bn" is not null),
	CONSTRAINT "order_items_quantity_range" CHECK ("order_items"."quantity" between 1 and 1000),
	CONSTRAINT "order_items_amounts_valid" CHECK ("order_items"."unit_price_paisa" > 0 and "order_items"."line_total_paisa" = "order_items"."unit_price_paisa" * "order_items"."quantity" and "order_items"."line_total_paisa" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "order_tracking_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "order_tracking_tokens_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "order_tracking_tokens_hash_format" CHECK ("order_tracking_tokens"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" bigint GENERATED ALWAYS AS IDENTITY (sequence name "orders_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source" text NOT NULL,
	"customer_name" text NOT NULL,
	"customer_phone" text NOT NULL,
	"delivery_address" text NOT NULL,
	"delivery_zone" text NOT NULL,
	"note" text,
	"subtotal_paisa" bigint NOT NULL,
	"delivery_charge_paisa" bigint NOT NULL,
	"total_paisa" bigint NOT NULL,
	"order_status" text NOT NULL,
	"fulfilment_status" text NOT NULL,
	"payment_status" text NOT NULL,
	"return_status" text NOT NULL,
	"cod_collected_paisa" bigint DEFAULT 0 NOT NULL,
	"cod_settled_paisa" bigint DEFAULT 0 NOT NULL,
	"refunded_paisa" bigint DEFAULT 0 NOT NULL,
	"rto_charge_paisa" bigint,
	"verification_expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_number_key" UNIQUE("number"),
	CONSTRAINT "orders_source_valid" CHECK ("orders"."source" in ('website', 'messenger', 'whatsapp', 'other')),
	CONSTRAINT "orders_customer_name_valid" CHECK (btrim("orders"."customer_name") <> '' and length("orders"."customer_name") <= 100),
	CONSTRAINT "orders_customer_phone_format" CHECK ("orders"."customer_phone" ~ '^01[3-9][0-9]{8}$'),
	CONSTRAINT "orders_address_valid" CHECK (btrim("orders"."delivery_address") <> '' and length("orders"."delivery_address") <= 500),
	CONSTRAINT "orders_note_valid" CHECK (btrim("orders"."note") <> '' and length("orders"."note") <= 1000),
	CONSTRAINT "orders_amounts_valid" CHECK ("orders"."subtotal_paisa" > 0 and "orders"."delivery_charge_paisa" >= 0 and "orders"."total_paisa" = "orders"."subtotal_paisa" + "orders"."delivery_charge_paisa" and "orders"."total_paisa" <= 9007199254740991),
	CONSTRAINT "orders_status_valid" CHECK ("orders"."order_status" in ('pending_verification', 'verification_expired', 'confirmed', 'cancelled', 'closed')),
	CONSTRAINT "orders_fulfilment_status_valid" CHECK ("orders"."fulfilment_status" in ('unfulfilled', 'packed', 'dispatched', 'delivered', 'rto', 'rto_received')),
	CONSTRAINT "orders_return_status_valid" CHECK ("orders"."return_status" in ('none', 'requested', 'in_progress', 'resolved')),
	CONSTRAINT "orders_cod_amounts_valid" CHECK ("orders"."cod_settled_paisa" >= 0 and "orders"."cod_settled_paisa" <= "orders"."cod_collected_paisa" and "orders"."cod_collected_paisa" <= "orders"."total_paisa" and "orders"."refunded_paisa" >= 0 and "orders"."refunded_paisa" <= "orders"."cod_collected_paisa"),
	CONSTRAINT "orders_payment_status_derived" CHECK ("orders"."payment_status" = case when "orders"."cod_collected_paisa" = 0 then 'unpaid' when "orders"."cod_collected_paisa" < "orders"."total_paisa" then 'partially_collected' when "orders"."cod_settled_paisa" < "orders"."cod_collected_paisa" then 'collected' else 'settled' end),
	CONSTRAINT "orders_rto_charge_valid" CHECK ("orders"."rto_charge_paisa" >= 0 and "orders"."rto_charge_paisa" <= 1000000),
	CONSTRAINT "orders_fulfilment_consistent" CHECK (("orders"."order_status" in ('pending_verification', 'verification_expired') and "orders"."fulfilment_status" = 'unfulfilled')
        or ("orders"."order_status" = 'cancelled' and "orders"."fulfilment_status" in ('unfulfilled', 'packed'))
        or ("orders"."order_status" = 'confirmed')
        or ("orders"."order_status" = 'closed' and "orders"."fulfilment_status" in ('delivered', 'rto_received'))),
	CONSTRAINT "orders_closed_at_consistent" CHECK (("orders"."closed_at" is not null) = ("orders"."order_status" in ('cancelled', 'closed'))),
	CONSTRAINT "orders_delivered_at_consistent" CHECK ("orders"."delivered_at" is null or "orders"."fulfilment_status" = 'delivered' or "orders"."order_status" = 'closed'),
	CONSTRAINT "orders_version_positive" CHECK ("orders"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "payment_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payment_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_paisa" bigint NOT NULL,
	"occurred_on" date NOT NULL,
	"method" text,
	"reference" text,
	"return_id" uuid,
	"actor_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_entries_kind_valid" CHECK ("payment_entries"."kind" in ('collected', 'settled', 'refunded')),
	CONSTRAINT "payment_entries_amount_valid" CHECK ("payment_entries"."amount_paisa" > 0 and "payment_entries"."amount_paisa" <= 9007199254740991),
	CONSTRAINT "payment_entries_refund_consistent" CHECK (("payment_entries"."kind" = 'refunded') = ("payment_entries"."method" is not null) and ("payment_entries"."kind" = 'refunded') = ("payment_entries"."return_id" is not null)),
	CONSTRAINT "payment_entries_method_valid" CHECK ("payment_entries"."method" in ('bkash', 'nagad', 'bank_transfer')),
	CONSTRAINT "payment_entries_reference_valid" CHECK (btrim("payment_entries"."reference") <> '' and length("payment_entries"."reference") <= 100)
);
--> statement-breakpoint
CREATE TABLE "quarantine_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"source" text NOT NULL,
	"return_id" uuid,
	"quantity" integer NOT NULL,
	"status" text NOT NULL,
	"note" text,
	"restock_movement_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"inspected_at" timestamp with time zone,
	"inspected_by_user_id" uuid,
	CONSTRAINT "quarantine_items_restock_movement_key" UNIQUE("restock_movement_id"),
	CONSTRAINT "quarantine_items_source_valid" CHECK ("quarantine_items"."source" in ('rto', 'return')),
	CONSTRAINT "quarantine_items_return_link" CHECK (("quarantine_items"."source" = 'return') = ("quarantine_items"."return_id" is not null)),
	CONSTRAINT "quarantine_items_quantity_positive" CHECK ("quarantine_items"."quantity" > 0),
	CONSTRAINT "quarantine_items_status_valid" CHECK ("quarantine_items"."status" in ('awaiting_inspection', 'restocked', 'rejected')),
	CONSTRAINT "quarantine_items_note_valid" CHECK (btrim("quarantine_items"."note") <> '' and length("quarantine_items"."note") <= 500),
	CONSTRAINT "quarantine_items_inspection_consistent" CHECK (("quarantine_items"."status" = 'awaiting_inspection') = ("quarantine_items"."inspected_at" is null) and ("quarantine_items"."inspected_at" is null) = ("quarantine_items"."inspected_by_user_id" is null) and ("quarantine_items"."status" = 'restocked') = ("quarantine_items"."restock_movement_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "return_items" (
	"return_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	CONSTRAINT "return_items_pkey" PRIMARY KEY("return_id","order_item_id"),
	CONSTRAINT "return_items_quantity_positive" CHECK ("return_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"shipping_paid_by" text NOT NULL,
	"return_shipping_cost_paisa" bigint,
	"status" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"received_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	CONSTRAINT "returns_kind_valid" CHECK ("returns"."kind" in ('return', 'exchange')),
	CONSTRAINT "returns_reason_valid" CHECK ("returns"."reason" in ('size_or_preference', 'wrong_or_defective')),
	CONSTRAINT "returns_shipping_responsibility" CHECK ("returns"."shipping_paid_by" = case when "returns"."reason" = 'wrong_or_defective' then 'business' else 'customer' end),
	CONSTRAINT "returns_shipping_cost_valid" CHECK ("returns"."return_shipping_cost_paisa" >= 0 and "returns"."return_shipping_cost_paisa" <= 1000000),
	CONSTRAINT "returns_status_valid" CHECK ("returns"."status" in ('requested', 'received', 'approved', 'rejected', 'completed')),
	CONSTRAINT "returns_note_valid" CHECK (btrim("returns"."note") <> '' and length("returns"."note") <= 500),
	CONSTRAINT "returns_dates_consistent" CHECK (("returns"."status" = 'requested') = ("returns"."received_at" is null) and ("returns"."status" in ('requested', 'received')) = ("returns"."decided_at" is null) and ("returns"."status" = 'completed') = ("returns"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "stock_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"status" text NOT NULL,
	"release_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "stock_reservations_quantity_positive" CHECK ("stock_reservations"."quantity" > 0),
	CONSTRAINT "stock_reservations_status_valid" CHECK ("stock_reservations"."status" in ('active', 'released', 'consumed')),
	CONSTRAINT "stock_reservations_end_consistent" CHECK (("stock_reservations"."status" = 'active' and "stock_reservations"."ended_at" is null and "stock_reservations"."release_reason" is null)
        or ("stock_reservations"."status" = 'released' and "stock_reservations"."ended_at" is not null and "stock_reservations"."release_reason" in ('cancelled', 'expired'))
        or ("stock_reservations"."status" = 'consumed' and "stock_reservations"."ended_at" is not null and "stock_reservations"."release_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "tracking_rate_limits" (
	"bucket" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "tracking_rate_limits_bucket_valid" CHECK ("tracking_rate_limits"."bucket" in ('lookup', 'failure')),
	CONSTRAINT "tracking_rate_limits_count_positive" CHECK ("tracking_rate_limits"."count" >= 1)
);
--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_type_valid";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_delta_valid";--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD COLUMN "reserved" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "order_id" uuid;--> statement-breakpoint
ALTER TABLE "cancellation_requests" ADD CONSTRAINT "cancellation_requests_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancellation_requests" ADD CONSTRAINT "cancellation_requests_reviewed_by_user_id_auth_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_zones" ADD CONSTRAINT "delivery_zones_updated_by_user_id_auth_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_actor_user_id_auth_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_tracking_tokens" ADD CONSTRAINT "order_tracking_tokens_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_delivery_zone_delivery_zones_code_fk" FOREIGN KEY ("delivery_zone") REFERENCES "public"."delivery_zones"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_user_id_auth_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_entries" ADD CONSTRAINT "payment_entries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_entries" ADD CONSTRAINT "payment_entries_return_id_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."returns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_entries" ADD CONSTRAINT "payment_entries_actor_user_id_auth_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quarantine_items" ADD CONSTRAINT "quarantine_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quarantine_items" ADD CONSTRAINT "quarantine_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quarantine_items" ADD CONSTRAINT "quarantine_items_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quarantine_items" ADD CONSTRAINT "quarantine_items_return_id_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."returns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quarantine_items" ADD CONSTRAINT "quarantine_items_restock_movement_id_stock_movements_id_fk" FOREIGN KEY ("restock_movement_id") REFERENCES "public"."stock_movements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quarantine_items" ADD CONSTRAINT "quarantine_items_inspected_by_user_id_auth_users_id_fk" FOREIGN KEY ("inspected_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_return_id_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."returns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_created_by_user_id_auth_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cancellation_requests_open_key" ON "cancellation_requests" USING btree ("order_id") WHERE "cancellation_requests"."status" = 'open';--> statement-breakpoint
CREATE INDEX "order_events_order_id_id_idx" ON "order_events" USING btree ("order_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_items_order_variant_key" ON "order_items" USING btree ("order_id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_tracking_tokens_active_key" ON "order_tracking_tokens" USING btree ("order_id") WHERE "order_tracking_tokens"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "orders_status_expiry_idx" ON "orders" USING btree ("order_status","verification_expires_at");--> statement-breakpoint
CREATE INDEX "orders_created_at_idx" ON "orders" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "payment_entries_order_id_idx" ON "payment_entries" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "quarantine_items_order_id_idx" ON "quarantine_items" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "returns_open_key" ON "returns" USING btree ("order_id") WHERE "returns"."status" in ('requested', 'received', 'approved');--> statement-breakpoint
CREATE UNIQUE INDEX "stock_reservations_active_key" ON "stock_reservations" USING btree ("order_id","variant_id") WHERE "stock_reservations"."status" = 'active';--> statement-breakpoint
CREATE INDEX "stock_reservations_order_id_idx" ON "stock_reservations" USING btree ("order_id");--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_reserved_valid" CHECK ("inventory_balances"."reserved" >= 0 and "inventory_balances"."reserved" <= "inventory_balances"."on_hand");--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_order_link" CHECK (("stock_movements"."movement_type" in ('dispatch', 'return_restock')) = ("stock_movements"."order_id" is not null));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_type_valid" CHECK ("stock_movements"."movement_type" in ('receipt', 'adjustment', 'dispatch', 'return_restock'));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_delta_valid" CHECK ("stock_movements"."quantity_delta" <> 0 and ("stock_movements"."movement_type" not in ('receipt', 'return_restock') or "stock_movements"."quantity_delta" > 0) and ("stock_movements"."movement_type" <> 'dispatch' or "stock_movements"."quantity_delta" < 0));--> statement-breakpoint
-- order_events and payment_entries are append-only, like stock_movements (migration 0001); same limitation:
-- the table owner or a superuser can drop or disable the triggers.
CREATE FUNCTION "append_only_reject_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "order_events_append_only"
BEFORE UPDATE OR DELETE OR TRUNCATE ON "order_events"
FOR EACH STATEMENT EXECUTE FUNCTION "append_only_reject_change"();
--> statement-breakpoint
CREATE TRIGGER "payment_entries_append_only"
BEFORE UPDATE OR DELETE OR TRUNCATE ON "payment_entries"
FOR EACH STATEMENT EXECUTE FUNCTION "append_only_reject_change"();
