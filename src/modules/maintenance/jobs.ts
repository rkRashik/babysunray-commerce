import { sql } from "drizzle-orm";
import type { Db } from "@/db/database";
import { expireOverdueVerifications } from "../orders/service";

// Maintenance jobs (Gate H.41) for `npm run maintenance:run` and, once hosting is chosen, a scheduler. Each job is
// bounded (a fixed batch per run), idempotent (a second run finds nothing more) and safe to run concurrently (single
// statements or skip-locked rows, so two runs never handle a row twice). Jobs delete only what is dead by its own
// definition: sessions past their expiry (unusable by Better Auth) and rate-limit windows long over. Business,
// audit, idempotency and personal data are never deleted: no retention period is approved, so those are reported.

export const BATCH = 1000;

/** Orders still Pending Verification after 24 hours: released and marked Verification Expired (rule D). */
export const expireVerifications = (db: Db) => expireOverdueVerifications(db, { limit: BATCH });

/**
 * Deletes up to BATCH sessions whose expiry has passed and records each in the authentication audit (reason
 * "expired"), in one statement, so a session never disappears unrecorded. Concurrent runs skip each other's rows.
 */
export async function removeExpiredSessions(db: Db): Promise<number> {
  const { rows } = await db.execute<{ n: number }>(sql`
    with due as (
      select id from auth_sessions where expires_at < now() order by expires_at limit ${BATCH} for update skip locked
    ), gone as (
      delete from auth_sessions s using due where s.id = due.id returning s.id, s.user_id
    ), audited as (
      insert into auth_events (event, actor_type, subject_user_id, session_id, detail)
      select 'session_ended', 'system', user_id, id, '{"reason":"expired"}'::jsonb from gone
      on conflict (session_id) where event = 'session_ended' do nothing
      returning 1
    )
    select (select count(*) from gone)::int as n`);
  return rows[0].n;
}

/** Rate-limit counters whose window ended more than an hour ago: they restart at 1 anyway, so nothing is lost. */
export async function removeStaleRateLimitWindows(db: Db): Promise<number> {
  const { rows } = await db.execute<{ n: number }>(sql`
    with a as (delete from api_rate_limits where window_start < now() - interval '1 hour' returning 1),
         t as (delete from tracking_rate_limits where window_start < now() - interval '1 hour' returning 1),
         b as (delete from auth_rate_limits where last_request < (extract(epoch from now() - interval '1 hour') * 1000)::bigint returning 1)
    select ((select count(*) from a) + (select count(*) from t) + (select count(*) from b))::int as n`);
  return rows[0].n;
}

export type HealthReport = {
  ledgerMismatch: number;
  reservedMismatch: number;
  strayHolds: number;
  unheldOrders: number;
  codMismatch: number;
  idempotencyRecords: number;
  oldestIdempotencyRecord: string | null;
  guestSubmissions: number;
  authEvents: number;
};

/** Read-only checks. The first five must be 0; the rest are sizes to watch while no retention period exists. */
export async function healthReport(db: Db): Promise<HealthReport> {
  const { rows } = await db.execute<Record<string, string | number | null>>(sql`select
    (select count(*) from inventory_balances b where b.on_hand <> coalesce((select sum(m.quantity_delta) from stock_movements m where m.variant_id = b.variant_id), 0))::int as ledger_mismatch,
    (select count(*) from inventory_balances b where b.reserved <> coalesce((select sum(r.quantity) from stock_reservations r where r.variant_id = b.variant_id and r.status = 'active'), 0))::int as reserved_mismatch,
    (select count(*) from stock_reservations r join orders o on o.id = r.order_id
      where r.status = 'active' and (o.order_status in ('cancelled', 'verification_expired', 'closed') or o.fulfilment_status not in ('unfulfilled', 'packed')))::int as stray_holds,
    (select count(*) from orders o where o.order_status = 'confirmed' and o.fulfilment_status in ('unfulfilled', 'packed')
      and not exists (select 1 from stock_reservations r where r.order_id = o.id and r.status = 'active'))::int as unheld_orders,
    (select count(*) from orders o where
       o.cod_collected_paisa <> coalesce((select sum(amount_paisa) from payment_entries p where p.order_id = o.id and p.kind = 'collected'), 0)
       or o.cod_settled_paisa <> coalesce((select sum(amount_paisa) from payment_entries p where p.order_id = o.id and p.kind = 'settled'), 0)
       or o.cod_deducted_paisa <> coalesce((select sum(amount_paisa) from payment_entries p where p.order_id = o.id and p.kind = 'deducted'), 0)
       or o.refunded_paisa <> coalesce((select sum(amount_paisa) from payment_entries p where p.order_id = o.id and p.kind = 'refunded'), 0))::int as cod_mismatch,
    (select count(*) from idempotency_records)::int as idempotency_records,
    (select min(created_at)::text from idempotency_records) as oldest_idempotency_record,
    (select count(*) from guest_checkout_submissions)::int as guest_submissions,
    (select count(*) from auth_events)::int as auth_events`);
  const r = rows[0];
  const n = (v: string | number | null) => Number(v ?? 0);
  return {
    ledgerMismatch: n(r.ledger_mismatch),
    reservedMismatch: n(r.reserved_mismatch),
    strayHolds: n(r.stray_holds),
    unheldOrders: n(r.unheld_orders),
    codMismatch: n(r.cod_mismatch),
    idempotencyRecords: n(r.idempotency_records),
    oldestIdempotencyRecord: r.oldest_idempotency_record === null ? null : String(r.oldest_idempotency_record),
    guestSubmissions: n(r.guest_submissions),
    authEvents: n(r.auth_events),
  };
}

export const integrityProblems = (h: HealthReport) => h.ledgerMismatch + h.reservedMismatch + h.strayHolds + h.unheldOrders + h.codMismatch;
