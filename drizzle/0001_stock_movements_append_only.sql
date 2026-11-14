-- Custom SQL migration file, put your code below! --
-- stock_movements is an append-only ledger: a mistake is corrected by a new reasoned adjustment,
-- never by editing or removing history. The statement-level trigger fires even when no row matches.
-- Limitation: the table owner (the application role today) or a superuser can still drop or disable
-- this trigger with DDL. See README.md (Database migrations) for what this does and does not protect.
CREATE FUNCTION "stock_movements_reject_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stock_movements is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "stock_movements_append_only"
BEFORE UPDATE OR DELETE OR TRUNCATE ON "stock_movements"
FOR EACH STATEMENT EXECUTE FUNCTION "stock_movements_reject_change"();
