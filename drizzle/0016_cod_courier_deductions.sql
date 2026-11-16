-- Gate H.36: courier deductions from collected COD (fees or other amounts the courier kept), recorded by the Owner
-- from the courier's statement; no amount is assumed. Reviewed by hand. The new column starts at 0 for every
-- order, so each existing row satisfies the widened checks exactly as before: settled + 0 <= collected, and the
-- payment status of every existing order is unchanged.
ALTER TABLE "orders" DROP CONSTRAINT "orders_cod_amounts_valid";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_payment_status_derived";--> statement-breakpoint
ALTER TABLE "payment_entries" DROP CONSTRAINT "payment_entries_kind_valid";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cod_deducted_paisa" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_cod_amounts_valid" CHECK ("orders"."cod_settled_paisa" >= 0 and "orders"."cod_deducted_paisa" >= 0 and "orders"."cod_settled_paisa" + "orders"."cod_deducted_paisa" <= "orders"."cod_collected_paisa" and "orders"."cod_collected_paisa" <= "orders"."total_paisa" and "orders"."refunded_paisa" >= 0 and "orders"."refunded_paisa" <= "orders"."cod_collected_paisa");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_payment_status_derived" CHECK ("orders"."payment_status" = case when "orders"."cod_collected_paisa" = 0 then 'unpaid' when "orders"."cod_collected_paisa" < "orders"."total_paisa" then 'partially_collected' when "orders"."cod_settled_paisa" + "orders"."cod_deducted_paisa" < "orders"."cod_collected_paisa" then 'collected' else 'settled' end);--> statement-breakpoint
ALTER TABLE "payment_entries" ADD CONSTRAINT "payment_entries_kind_valid" CHECK ("payment_entries"."kind" in ('collected', 'settled', 'deducted', 'refunded'));