import "server-only";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/** A Drizzle handle over a node-postgres pool. Services receive it from the caller; none is created here. */
export type Db = NodePgDatabase;

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
