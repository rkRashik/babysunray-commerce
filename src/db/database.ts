import "server-only";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";

/**
 * A Drizzle handle over node-postgres: the pool-backed database or an open transaction. Services receive it
 * from the caller; none is created here. Given a transaction, a service's own `db.transaction` becomes a
 * savepoint inside it, so several services can commit (or roll back) as one operation.
 */
export type Db = PgDatabase<NodePgQueryResultHKT>;

/**
 * The PostgreSQL SQLSTATE of a failed query, looking through Drizzle's error wrapper.
 * Drizzle's error message includes the query parameters, so it must never be logged or shown as is.
 */
export function pgErrorCode(error: unknown): string | undefined {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

export const PG_UNIQUE_VIOLATION = "23505";
export const PG_FOREIGN_KEY_VIOLATION = "23503";
export const PG_CHECK_VIOLATION = "23514";
export const PG_NUMERIC_OUT_OF_RANGE = "22003";
