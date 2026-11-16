-- Gate H.33: a storewide counter for anonymous guest checkout submissions (the guest checkout itself stays
-- unreachable). Reviewed by hand. The bucket check only gains the value 'checkout'; every existing row stays valid.
ALTER TABLE "tracking_rate_limits" DROP CONSTRAINT "tracking_rate_limits_bucket_valid";--> statement-breakpoint
ALTER TABLE "tracking_rate_limits" ADD CONSTRAINT "tracking_rate_limits_bucket_valid" CHECK ("tracking_rate_limits"."bucket" in ('failure', 'checkout') or "tracking_rate_limits"."bucket" ~ '^link:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');