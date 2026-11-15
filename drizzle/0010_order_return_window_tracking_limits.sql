-- Gate H.17: a delivered order is closed only after its 7-day return window, and tracking limits per live link.
-- Reviewed by hand. Additive except for the tracking bucket check, which is replaced: the global 'lookup'
-- counter is no longer used, so its row (a one-minute counter, never business data) is removed first.
ALTER TABLE "tracking_rate_limits" DROP CONSTRAINT "tracking_rate_limits_bucket_valid";--> statement-breakpoint
DELETE FROM "tracking_rate_limits" WHERE "bucket" = 'lookup';--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_closed_after_return_window" CHECK ("orders"."order_status" <> 'closed' or "orders"."fulfilment_status" <> 'delivered' or ("orders"."delivered_at" is not null and "orders"."closed_at" > "orders"."delivered_at" + interval '7 days'));--> statement-breakpoint
ALTER TABLE "tracking_rate_limits" ADD CONSTRAINT "tracking_rate_limits_bucket_valid" CHECK ("tracking_rate_limits"."bucket" = 'failure' or "tracking_rate_limits"."bucket" ~ '^link:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
