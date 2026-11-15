import "server-only";
import { type SQL, sql } from "drizzle-orm";
import type { Column } from "./formats";

// The export datasets (requirement D-8, for the data models that exist). Each is one flat table produced by a
// single SELECT; ids and relations are kept as columns (`order_id`, `variant_id`, ...), so a reader can join
// datasets again. Never exported: password hashes, sessions, tracking tokens or their digests, idempotency
// records, rate-limit counters. Expenses, suppliers and customers as a separate record do not exist yet.
//
// Filters: `date` applies to the column named in `dateColumn`; the order filters (source and the three
// statuses) apply to the order each row belongs to. A dataset only accepts the filters it lists.

export const ORDER_FILTERS = ["source", "orderStatus", "fulfilmentStatus", "paymentStatus"] as const;
export type OrderFilter = (typeof ORDER_FILTERS)[number];

export type ExportFilters = {
  from?: string;
  to?: string;
  source?: string;
  orderStatus?: string;
  fulfilmentStatus?: string;
  paymentStatus?: string;
};

export type Dataset = {
  name: string;
  title: string;
  personalData: boolean;
  /** What the date filter applies to; absent when the dataset takes no date filter. */
  dateColumn?: { sql: SQL; description: string; kind: "timestamp" | "date" };
  orderFilters: boolean;
  columns: Column[];
  /** The SELECT, with its WHERE conditions inserted and a stable ORDER BY. */
  query: (where: SQL) => SQL;
};

const iso = (column: string) => sql.raw(`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
const ref = (column: string) => sql.raw(`'ORD-' || lpad(${column}::text, 6, '0')`);

const t = (key: string, description?: string): Column => ({ key, type: "text", description });
const n = (key: string, description?: string): Column => ({ key, type: "integer", description });
const ts = (key: string, description?: string): Column => ({ key, type: "timestamp", description });

const ORDER_STATUS_COLUMNS = [t("source"), t("order_status"), t("fulfilment_status"), t("payment_status"), t("return_status")];

export const DATASETS: Dataset[] = [
  {
    name: "products_variants",
    title: "Products and variants",
    personalData: false,
    orderFilters: false,
    columns: [
      t("product_id"),
      t("slug"),
      t("name_en"),
      t("name_bn"),
      t("product_status"),
      t("variant_id"),
      t("sku"),
      t("size"),
      t("colour"),
      n("price_paisa", "Current price, integer paisa (100 paisa = 1 BDT)"),
      t("variant_status"),
      ts("product_created_at"),
      ts("variant_created_at"),
    ],
    query: (where) => sql`
      select p.id as product_id, p.slug, p.name_en, p.name_bn, p.status as product_status, v.id as variant_id, v.sku, v.size, v.colour,
             v.price_paisa, v.status as variant_status, ${iso("p.created_at")} as product_created_at, ${iso("v.created_at")} as variant_created_at
        from products p join variants v on v.product_id = p.id
       where ${where}
       order by p.created_at, p.id, v.created_at, v.id`,
  },
  {
    name: "stock",
    title: "Current stock (on hand, reserved, available, awaiting inspection)",
    personalData: false,
    orderFilters: false,
    columns: [
      t("variant_id"),
      t("sku"),
      t("product_name_en"),
      t("product_name_bn"),
      t("variant_status"),
      n("on_hand", "Physical sellable units in the shop"),
      n("reserved", "Units held for orders not dispatched yet"),
      n("available", "on_hand - reserved"),
      n("awaiting_inspection", "Returned or RTO units in quarantine; never part of on_hand"),
      ts("updated_at"),
    ],
    query: (where) => sql`
      select v.id as variant_id, v.sku, p.name_en as product_name_en, p.name_bn as product_name_bn, v.status as variant_status,
             b.on_hand, b.reserved, b.on_hand - b.reserved as available,
             coalesce((select sum(q.quantity) from quarantine_items q where q.variant_id = v.id and q.status = 'awaiting_inspection'), 0) as awaiting_inspection,
             ${iso("b.updated_at")} as updated_at
        from variants v join products p on p.id = v.product_id join inventory_balances b on b.variant_id = v.id
       where ${where}
       order by v.sku`,
  },
  {
    name: "stock_movements",
    title: "Stock movement ledger (append-only)",
    personalData: false,
    dateColumn: { sql: sql`m.created_at`, description: "when the movement was recorded", kind: "timestamp" },
    orderFilters: false,
    columns: [
      n("movement_id"),
      ts("created_at"),
      t("variant_id"),
      t("sku"),
      t("movement_type"),
      n("quantity_delta"),
      t("reason"),
      t("order_id"),
      t("order_reference"),
      t("actor_type"),
      t("actor_ref", "A system label, or the acting user's id"),
    ],
    query: (where) => sql`
      select m.id as movement_id, ${iso("m.created_at")} as created_at, m.variant_id, v.sku, m.movement_type, m.quantity_delta, m.reason, m.order_id,
             case when o.number is null then null else ${ref("o.number")} end as order_reference, m.actor_type, m.actor_ref
        from stock_movements m join variants v on v.id = m.variant_id left join orders o on o.id = m.order_id
       where ${where}
       order by m.id`,
  },
  {
    name: "orders",
    title: "Orders (with customer contact details)",
    personalData: true,
    dateColumn: { sql: sql`o.created_at`, description: "when the order was submitted", kind: "timestamp" },
    orderFilters: true,
    columns: [
      t("order_id"),
      t("order_reference"),
      ts("created_at"),
      ...ORDER_STATUS_COLUMNS,
      t("customer_name"),
      t("customer_phone", "Bangladesh mobile number as text, leading zero kept"),
      t("delivery_address"),
      t("delivery_zone"),
      t("note"),
      n("subtotal_paisa"),
      n("delivery_charge_paisa"),
      n("total_paisa", "Expected COD; not a sale until collected and settled"),
      n("cod_collected_paisa"),
      n("cod_settled_paisa"),
      n("refunded_paisa"),
      n("rto_charge_paisa"),
      n("item_lines"),
      n("item_units"),
      n("items_total_paisa", "Sum of the order's line totals, read in the same snapshot (equals subtotal_paisa)"),
      ts("verification_expires_at"),
      ts("confirmed_at"),
      ts("delivered_at"),
      ts("closed_at"),
      n("version"),
    ],
    query: (where) => sql`
      select o.id as order_id, ${ref("o.number")} as order_reference, ${iso("o.created_at")} as created_at, o.source, o.order_status, o.fulfilment_status,
             o.payment_status, o.return_status, o.customer_name, o.customer_phone, o.delivery_address, o.delivery_zone, o.note,
             o.subtotal_paisa, o.delivery_charge_paisa, o.total_paisa, o.cod_collected_paisa, o.cod_settled_paisa, o.refunded_paisa, o.rto_charge_paisa,
             i.lines as item_lines, i.units as item_units, i.total as items_total_paisa,
             ${iso("o.verification_expires_at")} as verification_expires_at, ${iso("o.confirmed_at")} as confirmed_at,
             ${iso("o.delivered_at")} as delivered_at, ${iso("o.closed_at")} as closed_at, o.version
        from orders o
        cross join lateral (select count(*) as lines, coalesce(sum(quantity), 0) as units, coalesce(sum(line_total_paisa), 0) as total
                              from order_items where order_id = o.id) i
       where ${where}
       order by o.created_at, o.id`,
  },
  {
    name: "order_items",
    title: "Order items (price snapshot at submission)",
    personalData: false,
    dateColumn: { sql: sql`o.created_at`, description: "when the order was submitted", kind: "timestamp" },
    orderFilters: true,
    columns: [
      t("order_item_id"),
      t("order_id"),
      t("order_reference"),
      ts("order_created_at"),
      t("variant_id"),
      t("sku"),
      t("product_name_en"),
      t("product_name_bn"),
      t("size"),
      t("colour"),
      n("unit_price_paisa"),
      n("quantity"),
      n("line_total_paisa"),
    ],
    query: (where) => sql`
      select i.id as order_item_id, i.order_id, ${ref("o.number")} as order_reference, ${iso("o.created_at")} as order_created_at, i.variant_id, i.sku,
             i.product_name_en, i.product_name_bn, i.size, i.colour, i.unit_price_paisa, i.quantity, i.line_total_paisa
        from order_items i join orders o on o.id = i.order_id
       where ${where}
       order by o.created_at, o.id, i.sku`,
  },
  {
    name: "order_events",
    title: "Order history (append-only audit)",
    personalData: false,
    dateColumn: { sql: sql`e.created_at`, description: "when the event was recorded", kind: "timestamp" },
    orderFilters: true,
    columns: [n("event_id"), ts("created_at"), t("order_id"), t("order_reference"), t("event"), t("actor_type"), t("actor_ref"), { key: "detail", type: "json" }],
    query: (where) => sql`
      select e.id as event_id, ${iso("e.created_at")} as created_at, e.order_id, ${ref("o.number")} as order_reference, e.event, e.actor_type, e.actor_ref, e.detail
        from order_events e join orders o on o.id = e.order_id
       where ${where}
       order by e.id`,
  },
  {
    name: "payments",
    title: "COD collection, settlement and refunds (append-only)",
    personalData: false,
    dateColumn: { sql: sql`pe.occurred_on`, description: "the date entered for the payment", kind: "date" },
    orderFilters: true,
    columns: [
      n("payment_entry_id"),
      t("order_id"),
      t("order_reference"),
      t("kind", "collected (by the courier), settled (to the Owner) or refunded (to the customer)"),
      n("amount_paisa"),
      { key: "occurred_on", type: "date" },
      t("method"),
      t("reference"),
      t("return_id"),
      t("actor_user_id"),
      ts("created_at"),
    ],
    query: (where) => sql`
      select pe.id as payment_entry_id, pe.order_id, ${ref("o.number")} as order_reference, pe.kind, pe.amount_paisa, pe.occurred_on::text as occurred_on,
             pe.method, pe.reference, pe.return_id, pe.actor_user_id, ${iso("pe.created_at")} as created_at
        from payment_entries pe join orders o on o.id = pe.order_id
       where ${where}
       order by pe.id`,
  },
  {
    name: "returns",
    title: "Returns, exchanges and refunds",
    personalData: false,
    dateColumn: { sql: sql`r.created_at`, description: "when the return was requested", kind: "timestamp" },
    orderFilters: true,
    columns: [
      t("return_id"),
      t("order_id"),
      t("order_reference"),
      t("kind"),
      t("reason"),
      t("status"),
      t("shipping_paid_by"),
      n("return_shipping_cost_paisa"),
      n("item_units"),
      n("items_value_paisa"),
      n("refunded_paisa", "Refund entries recorded for this return"),
      t("note"),
      ts("created_at"),
      ts("received_at"),
      ts("decided_at"),
      ts("completed_at"),
    ],
    query: (where) => sql`
      select r.id as return_id, r.order_id, ${ref("o.number")} as order_reference, r.kind, r.reason, r.status, r.shipping_paid_by, r.return_shipping_cost_paisa,
             x.units as item_units, x.value as items_value_paisa,
             (select coalesce(sum(amount_paisa), 0) from payment_entries where return_id = r.id and kind = 'refunded') as refunded_paisa,
             r.note, ${iso("r.created_at")} as created_at, ${iso("r.received_at")} as received_at, ${iso("r.decided_at")} as decided_at,
             ${iso("r.completed_at")} as completed_at
        from returns r join orders o on o.id = r.order_id
        cross join lateral (select coalesce(sum(ri.quantity), 0) as units, coalesce(sum(ri.quantity * oi.unit_price_paisa), 0) as value
                              from return_items ri join order_items oi on oi.id = ri.order_item_id where ri.return_id = r.id) x
       where ${where}
       order by r.created_at, r.id`,
  },
  {
    name: "quarantine",
    title: "Returned and RTO goods in inspection (quarantine)",
    personalData: false,
    dateColumn: { sql: sql`q.created_at`, description: "when the goods were received into quarantine", kind: "timestamp" },
    orderFilters: true,
    columns: [
      t("quarantine_item_id"),
      t("order_id"),
      t("order_reference"),
      t("source"),
      t("return_id"),
      t("variant_id"),
      t("sku"),
      n("quantity"),
      t("status"),
      t("note"),
      n("restock_movement_id"),
      ts("received_at"),
      ts("inspected_at"),
      t("inspected_by_user_id"),
    ],
    query: (where) => sql`
      select q.id as quarantine_item_id, q.order_id, ${ref("o.number")} as order_reference, q.source, q.return_id, q.variant_id, v.sku, q.quantity, q.status,
             q.note, q.restock_movement_id, ${iso("q.created_at")} as received_at, ${iso("q.inspected_at")} as inspected_at, q.inspected_by_user_id
        from quarantine_items q join orders o on o.id = q.order_id join variants v on v.id = q.variant_id
       where ${where}
       order by q.created_at, q.id`,
  },
  {
    name: "delivery_zones",
    title: "Delivery zone charges",
    personalData: false,
    orderFilters: false,
    columns: [t("code"), n("charge_paisa"), { key: "active", type: "boolean" }, n("version"), ts("updated_at"), t("updated_by_user_id")],
    query: (where) => sql`
      select code, charge_paisa, active, version, ${iso("updated_at")} as updated_at, updated_by_user_id from delivery_zones where ${where} order by code`,
  },
  {
    name: "stock_counts",
    title: "Physical stock counts and their corrections",
    personalData: false,
    dateColumn: { sql: sql`c.created_at`, description: "when the count was started", kind: "timestamp" },
    orderFilters: false,
    columns: [
      t("count_id"),
      t("count_reference"),
      t("count_status"),
      ts("count_started_at"),
      ts("count_closed_at"),
      t("count_reason"),
      t("variant_id"),
      t("sku"),
      n("snapshot_on_hand"),
      n("snapshot_reserved"),
      n("counted"),
      ts("counted_at"),
      n("basis_on_hand", "On hand when the count was entered"),
      n("applied_delta"),
      n("movement_id"),
    ],
    query: (where) => sql`
      select c.id as count_id, 'COUNT-' || lpad(c.number::text, 6, '0') as count_reference, c.status as count_status, ${iso("c.created_at")} as count_started_at,
             ${iso("c.closed_at")} as count_closed_at, c.reason as count_reason, l.variant_id, v.sku, l.snapshot_on_hand, l.snapshot_reserved, l.counted,
             ${iso("l.counted_at")} as counted_at, l.basis_on_hand, l.applied_delta, l.movement_id
        from stock_counts c join stock_count_lines l on l.count_id = c.id join variants v on v.id = l.variant_id
       where ${where}
       order by c.created_at, c.id, v.sku`,
  },
  {
    name: "export_requests",
    title: "Export audit log",
    personalData: false,
    dateColumn: { sql: sql`x.created_at`, description: "when the export was requested", kind: "timestamp" },
    orderFilters: false,
    columns: [n("export_request_id"), ts("created_at"), t("actor_user_id"), t("dataset"), t("format"), t("scope"), { key: "filters", type: "json" }],
    query: (where) => sql`
      select x.id as export_request_id, ${iso("x.created_at")} as created_at, x.actor_user_id, x.dataset, x.format, x.scope, x.filters
        from export_requests x where ${where} order by x.id`,
  },
];

export const findDataset = (name: unknown) => DATASETS.find((d) => d.name === name);
