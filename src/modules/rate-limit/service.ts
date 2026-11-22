import "server-only";
import { sql } from "drizzle-orm";
import type { Db } from "@/db/database";

// Fixed-window request limits for /api/v1, per verified user and category, stored in PostgreSQL so every
// application process shares them. Callers count a request only after authentication, so anonymous traffic
// never touches a user's counter. These are technical limits against runaway clients, not business policy.

export type RateLimitBucket = "read" | "write";
export type RateLimits = Record<RateLimitBucket, number>;
export const RATE_LIMIT_WINDOW_SECONDS = 60;
const DEFAULTS: RateLimits = { read: 300, write: 60 };

const ENV: Record<RateLimitBucket, string> = {
  read: "API_RATE_LIMIT_READS_PER_MINUTE",
  write: "API_RATE_LIMIT_WRITES_PER_MINUTE",
};

/** Requests per user and minute, from the environment (optional; defaults 300 reads and 60 writes). */
export function readRateLimits(env: Record<string, string | undefined>): RateLimits {
  const limits = { ...DEFAULTS };
  for (const bucket of ["read", "write"] as const) {
    const raw = env[ENV[bucket]];
    if (raw === undefined || raw === "") continue;
    if (!/^[1-9][0-9]{0,5}$/.test(raw)) throw new Error(`${ENV[bucket]} must be a whole number from 1 to 999999.`);
    limits[bucket] = Number(raw);
  }
  return limits;
}

/** A counter for anonymous requests: storewide, per tracking link, or per client behind a trusted proxy (tracking_rate_limits). */
export type PublicBucket = "failure" | "checkout" | "admin-setup" | "admin-recovery" | "staff-invite" | `link:${string}` | `checkout-client:${string}`;

/**
 * Counts one anonymous request in `bucket`'s current window (a minute, or an hour; fixed windows, one atomic upsert) and
 * says whether it is within `limit`. A storewide bucket can be used up by anyone: it bounds how much work and how many
 * stock holds a flood can cause, it does not stop one client from crowding out others (a per-client bucket does that).
 */
export async function consumePublicLimit(db: Db, bucket: PublicBucket, limit: number, window: "minute" | "hour" = "minute"): Promise<boolean> {
  const unit = window === "hour" ? sql`'hour'` : sql`'minute'`;
  const { rows } = await db.execute<{ count: number }>(sql`
    insert into tracking_rate_limits as r (bucket, window_start, count)
    values (${bucket}, date_trunc(${unit}, now()), 1)
    on conflict (bucket) do update set
      count = case when r.window_start = excluded.window_start then r.count + 1 else 1 end,
      window_start = excluded.window_start
    returning count`);
  return rows[0].count <= limit;
}

/**
 * Counts one request in the user's current window and says whether it is within `limit`. One atomic
 * upsert: concurrent requests serialise on the counter row, so exactly `limit` requests per window pass.
 * A request in a new window starts the count again at 1.
 */
export async function consumeRateLimit(
  db: Db,
  userId: string,
  bucket: RateLimitBucket,
  limit: number,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const window = RATE_LIMIT_WINDOW_SECONDS;
  const { rows } = await db.execute<{ count: number; retry_after: string }>(sql`
    insert into api_rate_limits as r (user_id, bucket, window_start, count)
    values (${userId}, ${bucket}, to_timestamp(floor(extract(epoch from now()) / ${window}) * ${window}), 1)
    on conflict (user_id, bucket) do update set
      count = case when r.window_start = excluded.window_start then r.count + 1 else 1 end,
      window_start = excluded.window_start
    returning count, ceil(extract(epoch from (window_start + make_interval(secs => ${window}) - now()))) as retry_after
  `);
  const [row] = rows;
  return { allowed: row.count <= limit, retryAfterSeconds: Math.max(1, Number(row.retry_after)) };
}
