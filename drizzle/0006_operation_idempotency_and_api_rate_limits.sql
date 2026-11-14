CREATE TABLE "api_rate_limits" (
	"user_id" uuid NOT NULL,
	"bucket" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "api_rate_limits_pkey" PRIMARY KEY("user_id","bucket"),
	CONSTRAINT "api_rate_limits_bucket_valid" CHECK ("api_rate_limits"."bucket" in ('read', 'write')),
	CONSTRAINT "api_rate_limits_count_positive" CHECK ("api_rate_limits"."count" >= 1)
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"user_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"operation" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_records_pkey" PRIMARY KEY("user_id","idempotency_key"),
	CONSTRAINT "idempotency_records_key_format" CHECK ("idempotency_records"."idempotency_key" ~ '^[A-Za-z0-9_.:-]{16,128}$'),
	CONSTRAINT "idempotency_records_operation_format" CHECK ("idempotency_records"."operation" ~ '^[a-z][a-z0-9.-]{0,63}$'),
	CONSTRAINT "idempotency_records_fingerprint_format" CHECK ("idempotency_records"."request_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "idempotency_records_result_object" CHECK (jsonb_typeof("idempotency_records"."result") = 'object')
);
--> statement-breakpoint
ALTER TABLE "api_rate_limits" ADD CONSTRAINT "api_rate_limits_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;