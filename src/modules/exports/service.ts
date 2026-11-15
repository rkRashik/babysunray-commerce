import "server-only";
import { desc, type SQL, sql } from "drizzle-orm";
import type { Db } from "@/db/database";
import { exportRequests } from "@/db/schema";
import { assertPermission, type Principal } from "../auth/principal";
import { DomainError, invalidInput } from "../domain-error";
import { ORDER_SOURCES } from "../orders/rules";
import { parseDateRange, rangeInstants, TIME_ZONE } from "../reports/dates";
import { type Dataset, DATASETS, type ExportFilters, findDataset, ORDER_FILTERS } from "./datasets";
import { type Column, csvChunks, jsonChunks, type Row, type Value, xlsxChunks } from "./formats";

// Owner exports (requirements D-1 to D-8). Every request is checked for the exports:create permission, then
// recorded in export_requests (who, when, dataset, format, filters) before any data is read. The data is read
// in one read-only REPEATABLE READ transaction through a server-side cursor, 500 rows at a time, so every row
// of one file comes from the same database snapshot and memory stays bounded. Nothing is written to disk: the
// file is streamed to the caller and never stored, so no download link exists to leak or outlive a session.

export const EXPORT_SCHEMA_VERSION = 1;
export const EXPORT_FORMATS = ["xlsx", "csv", "json"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
/** Technical bound on one file (not a business rule); a larger export is refused before it starts. */
export const MAX_EXPORT_ROWS = 100_000;
const BATCH = 500;
export const EXPORT_TOO_LARGE = `This export has more than ${MAX_EXPORT_ROWS} rows. Narrow the dates or filters.`;
const STATEMENT_TIMEOUT = "120s";

const STATUS_VALUES: Record<(typeof ORDER_FILTERS)[number], readonly string[]> = {
  source: ORDER_SOURCES,
  orderStatus: ["pending_verification", "verification_expired", "confirmed", "cancelled", "closed"],
  fulfilmentStatus: ["unfulfilled", "packed", "dispatched", "delivered", "rto", "rto_received"],
  paymentStatus: ["unpaid", "partially_collected", "collected", "settled"],
};
const ORDER_COLUMN: Record<(typeof ORDER_FILTERS)[number], string> = {
  source: "o.source",
  orderStatus: "o.order_status",
  fulfilmentStatus: "o.fulfilment_status",
  paymentStatus: "o.payment_status",
};

export type ExportRequest = { dataset: string; format: string; filters: ExportFilters };
export type ValidExport = { dataset: Dataset; format: ExportFormat; filters: ExportFilters; scope: "complete" | "filtered" };

const CONTENT_TYPES: Record<ExportFormat, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
  json: "application/json; charset=utf-8",
};

/** Validates a request: a known dataset and format, and only filters the dataset accepts, with valid values. */
export function validateExport(request: ExportRequest): ValidExport {
  const dataset = findDataset(request.dataset);
  if (!dataset) throw invalidInput("dataset", "is not a known export");
  if (!(EXPORT_FORMATS as readonly string[]).includes(request.format)) throw invalidInput("format", "must be xlsx, csv or json");
  const filters: ExportFilters = {};
  const raw = request.filters;
  if (raw.from || raw.to) {
    if (!dataset.dateColumn) throw invalidInput("from", "does not apply to this dataset");
    if (!raw.from || !raw.to) throw invalidInput("from", "and the end date must both be given");
    Object.assign(filters, parseDateRange(raw.from, raw.to));
  }
  for (const name of ORDER_FILTERS) {
    const value = raw[name];
    if (!value) continue;
    if (!dataset.orderFilters) throw invalidInput(name, "does not apply to this dataset");
    if (!STATUS_VALUES[name].includes(value)) throw invalidInput(name, "is not a valid value");
    filters[name] = value;
  }
  return { dataset, format: request.format as ExportFormat, filters, scope: Object.keys(filters).length ? "filtered" : "complete" };
}

function whereFor(v: ValidExport): SQL {
  const parts: SQL[] = [sql`true`];
  const { dataset, filters } = v;
  if (filters.from && filters.to && dataset.dateColumn) {
    if (dataset.dateColumn.kind === "date") parts.push(sql`${dataset.dateColumn.sql} between ${filters.from}::date and ${filters.to}::date`);
    else {
      const { start, end } = rangeInstants({ from: filters.from, to: filters.to });
      parts.push(sql`${dataset.dateColumn.sql} >= ${start} and ${dataset.dateColumn.sql} < ${end}`);
    }
  }
  for (const name of ORDER_FILTERS) if (filters[name]) parts.push(sql`${sql.raw(ORDER_COLUMN[name])} = ${filters[name]}`);
  return sql.join(parts, sql` and `);
}

const SNAPSHOT = { isolationLevel: "repeatable read", accessMode: "read only" } as const;

/**
 * Runs `body` inside a transaction and hands its values to the consumer one at a time: the transaction stays
 * open while the consumer reads, waits while the consumer is slow, and rolls back if the consumer stops early.
 */
async function* inTransaction<T>(db: Db, body: (tx: Db, emit: (value: T) => Promise<void>) => Promise<void>): AsyncGenerator<T> {
  const queue: T[] = [];
  let finished = false;
  let failure: unknown = null;
  let stopped = false;
  // Assigned inside Promise executors; the casts keep TypeScript from narrowing them to null.
  let wakeConsumer = null as (() => void) | null;
  let wakeProducer = null as (() => void) | null;
  const stop = new Error("Export stopped by the reader.");
  const producer = db
    .transaction(async (tx) => {
      await body(tx, async (value) => {
        if (stopped) throw stop;
        queue.push(value);
        wakeConsumer?.();
        if (queue.length >= 2) await new Promise<void>((resolve) => (wakeProducer = resolve));
        if (stopped) throw stop;
      });
    }, SNAPSHOT)
    .then(
      () => void (finished = true),
      (error: unknown) => {
        failure = error;
        finished = true;
      },
    )
    .finally(() => wakeConsumer?.());
  try {
    while (true) {
      if (queue.length) {
        const value = queue.shift() as T;
        wakeProducer?.();
        wakeProducer = null;
        yield value;
      } else if (finished) {
        if (failure && failure !== stop) throw failure;
        return;
      } else {
        await new Promise<void>((resolve) => (wakeConsumer = resolve));
        wakeConsumer = null;
      }
    }
  } finally {
    stopped = true;
    wakeProducer?.();
    await producer;
  }
}

/** Converts a database value to its export type (bigint text → exact integer). */
function typed(column: Column, value: unknown): Value {
  if (value === null || value === undefined) return null;
  if (column.type === "integer") {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) throw new Error("Export value is not an exact integer.");
    return n;
  }
  if (column.type === "boolean") return Boolean(value);
  if (column.type === "json") return value as Record<string, unknown>;
  return String(value);
}

/** Every matching row, in batches, from one snapshot; refuses (before any row) more than MAX_EXPORT_ROWS. */
function rowBatches(db: Db, v: ValidExport): AsyncGenerator<Row[]> {
  const query = v.dataset.query(whereFor(v));
  return inTransaction<Row[]>(db, async (tx, emit) => {
    await tx.execute(sql`set local statement_timeout = ${sql.raw(`'${STATEMENT_TIMEOUT}'`)}`);
    const { rows } = await tx.execute<{ n: string }>(sql`select count(*) as n from (${query}) counted`);
    if (Number(rows[0].n) > MAX_EXPORT_ROWS) throw new DomainError("INVALID_INPUT", EXPORT_TOO_LARGE);
    await tx.execute(sql`declare export_rows no scroll cursor for ${query}`);
    while (true) {
      const batch = await tx.execute<Record<string, unknown>>(sql.raw(`fetch forward ${BATCH} from export_rows`));
      if (batch.rows.length === 0) break;
      await emit(batch.rows.map((r) => Object.fromEntries(v.dataset.columns.map((c) => [c.key, typed(c, r[c.key])]))));
    }
  });
}

/** Counts the rows an export would contain (same filters), for the size check before the audit and download. */
export async function countExportRows(db: Db, v: ValidExport): Promise<number> {
  const { rows } = await db.transaction((tx) => tx.execute<{ n: string }>(sql`select count(*) as n from (${v.dataset.query(whereFor(v))}) counted`), SNAPSHOT);
  return Number(rows[0].n);
}

export type ExportFile = { filename: string; contentType: string; chunks: AsyncGenerator<Uint8Array>; exportRequestId: number };

/**
 * Checks permission and the request, refuses an oversized export, records the request, and returns the file as
 * a stream of bytes (nothing has been read yet when this returns, apart from the row count).
 */
export async function createExport(db: Db, principal: Principal, request: ExportRequest): Promise<ExportFile> {
  const user = assertPermission(principal, "exports:create");
  const v = validateExport(request);
  if ((await countExportRows(db, v)) > MAX_EXPORT_ROWS) {
    throw new DomainError("INVALID_INPUT", EXPORT_TOO_LARGE);
  }
  const [audit] = await db
    .insert(exportRequests)
    .values({ actorUserId: user.userId, dataset: v.dataset.name, format: v.format, scope: v.scope, filters: v.filters })
    .returning({ id: exportRequests.id, createdAt: exportRequests.createdAt });
  const created = audit.createdAt.toISOString();
  const meta = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    dataset: v.dataset.name,
    title: v.dataset.title,
    scope: v.scope,
    filters: v.filters,
    createdAt: created,
    timeZone: TIME_ZONE,
    exportRequestId: audit.id,
    amounts: "integer paisa (100 paisa = 1 BDT)",
    timestamps: "ISO 8601 in UTC",
  };
  const batches = rowBatches(db, v);
  const chunks =
    v.format === "csv"
      ? csvChunks(v.dataset.columns, batches)
      : v.format === "json"
        ? jsonChunks(meta, v.dataset.columns, batches)
        : xlsxChunks(v.dataset.name.slice(0, 31), aboutRows(v, created, audit.id), v.dataset.columns, batches);
  const stamp = created.slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  return { filename: `${v.dataset.name}-${v.scope}-${stamp}Z.${v.format}`, contentType: CONTENT_TYPES[v.format], chunks, exportRequestId: audit.id };
}

function aboutRows(v: ValidExport, created: string, id: number): [string, string][] {
  return [
    ["Dataset", `${v.dataset.name}: ${v.dataset.title}`],
    ["Scope", v.scope === "complete" ? "Complete export (every record)" : "Filtered export (only matching records)"],
    ["Filters", Object.keys(v.filters).length ? JSON.stringify(v.filters) : "none"],
    ["Date filter applies to", v.dataset.dateColumn ? v.dataset.dateColumn.description : "not applicable"],
    ["Created (UTC)", created],
    ["Times in the data sheet", `${TIME_ZONE} local time (columns ending in _dhaka)`],
    ["Amounts", "Integer paisa (100 paisa = 1 BDT); not sales or profit"],
    ["Export schema version", String(EXPORT_SCHEMA_VERSION)],
    ["Export request id", String(id)],
    ["Contains personal data", v.dataset.personalData ? "Yes: customer contact details. Keep private." : "No customer contact details"],
  ];
}

/** The latest export audit rows, newest first (Owner Office). */
export async function listRecentExports(db: Db, principal: Principal, limit = 20) {
  assertPermission(principal, "exports:create");
  return db.select().from(exportRequests).orderBy(desc(exportRequests.id)).limit(limit);
}

export { DATASETS };
