// A bulkhead for anonymous database work (Gate H.40). Without a trusted client address (no reverse proxy is chosen,
// decision 1) a per-client rate limit is impossible, and a storewide limit per minute would let one visitor lock
// every customer out. Instead, at most ANONYMOUS_CONCURRENCY anonymous requests use the database at once in this
// process (the pool has 10 connections, src/db/client.ts), a few more wait briefly, and the rest are refused at
// once. Anonymous traffic can therefore slow anonymous pages, but can never take the connections the Owner and the
// checkout need. Process-local: each application process has its own; no state is shared or stored.
// shortcut: fixed sizes per process; replace with per-client limits once hosting provides a trusted client address.

import { configuredPoolMax } from "../../db/pool-settings";

// Sizes follow the configured pool P (DATABASE_POOL_MAX; 10 by default). From P = 5: 40% for anonymous reads and 20%
// each for checkout and /api/auth (4 + 2 + 2 at 10), each its own bulkhead, so at least a fifth of the pool stays free
// for the Owner. Below 5 (the serverless sizes, Gate H.45) there are not enough connections for three bulkheads plus a
// reserve, so /api/auth keeps its own bulkhead of 1 (the Owner's sign-in must never wait behind a tracking flood),
// anonymous reads and checkout share ONE bulkhead of max(1, P - 2), and the rest is free for the Owner's pages: one
// connection at P = 3 or 4, none at P = 2 or 1. Without a reserve, Owner pages queue behind at most two anonymous
// requests' worth of database work (milliseconds each), never refused; nothing deadlocks: no code path holds a
// connection while waiting for another.
// Per process only: with several function instances each has its own limits, so the total across instances is the
// per-instance limit times the instance count. That is protection for the database, NOT a global rate limit.
export type BulkheadPlan = { shared: boolean; reads: number; checkout: number; auth: number };
export function bulkheadPlan(pool: number): BulkheadPlan {
  if (pool < 5) {
    const shared = Math.max(1, pool - 2);
    return { shared: true, reads: shared, checkout: shared, auth: 1 };
  }
  return { shared: false, reads: Math.floor(pool * 0.4), checkout: Math.floor(pool * 0.2), auth: Math.floor(pool * 0.2) };
}
const PLAN = bulkheadPlan(configuredPoolMax(process.env));

export const ANONYMOUS_CONCURRENCY = PLAN.reads;
export const ANONYMOUS_QUEUE = 16;
export const ANONYMOUS_WAIT_MS = 2_000;

export type Bulkhead = <T>(work: () => Promise<T>) => Promise<{ ok: true; value: T } | { ok: false }>;

/** Runs work with at most `limit` at once; up to `queue` callers wait at most `waitMs` for a slot, others are refused. */
export function createBulkhead(limit: number, queue: number, waitMs: number): Bulkhead {
  let active = 0;
  const waiting: (() => void)[] = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };
  const acquire = (): Promise<boolean> => {
    if (active < limit) {
      active += 1;
      return Promise.resolve(true);
    }
    if (waiting.length >= queue) return Promise.resolve(false);
    return new Promise((resolve) => {
      const grant = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        const at = waiting.indexOf(grant);
        if (at >= 0) waiting.splice(at, 1);
        resolve(false);
      }, waitMs);
      waiting.push(grant);
    });
  };
  return async (work) => {
    if (!(await acquire())) return { ok: false };
    try {
      return { ok: true, value: await work() };
    } finally {
      release();
    }
  };
}

/** Shared by every anonymous read of this process: tracking, and the (unrouted) catalogue and quote. */
export const anonymousDatabaseWork: Bulkhead = createBulkhead(ANONYMOUS_CONCURRENCY, ANONYMOUS_QUEUE, ANONYMOUS_WAIT_MS);
const sharedOr = (own: () => Bulkhead): Bulkhead => (PLAN.shared ? anonymousDatabaseWork : own());

/**
 * The (unrouted) guest checkout's own, smaller bulkhead: a flood of catalogue reads cannot block ordering, nor the
 * reverse.
 */
export const CHECKOUT_CONCURRENCY = PLAN.checkout;
export const anonymousCheckoutWork: Bulkhead = sharedOr(() => createBulkhead(CHECKOUT_CONCURRENCY, 8, ANONYMOUS_WAIT_MS));

/**
 * Better Auth's HTTP endpoints (/api/auth). Sign-in is anonymous until it succeeds, so it cannot be told apart from a
 * flood; its own bulkhead keeps the Office's pages and the API, which verify sessions in server code rather than over
 * /api/auth, working during one. The bulkheads together use at most 80% of the pool (8 of 10 by default), or the shared bulkhead plus 1 below 5.
 */
export const AUTH_CONCURRENCY = PLAN.auth;
export const authEndpointWork: Bulkhead = createBulkhead(AUTH_CONCURRENCY, ANONYMOUS_QUEUE, ANONYMOUS_WAIT_MS);
