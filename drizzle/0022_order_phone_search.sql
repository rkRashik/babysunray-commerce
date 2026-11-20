-- Admin order search by phone (Phase 1). Reviewed by hand. Additive: one index, no data change. The search works without it
-- (slower on a large order table); apply it with the usual backup-first staging procedure.
CREATE INDEX "orders_customer_phone_idx" ON "orders" USING btree ("customer_phone","created_at","id");
