// A bulkhead for anonymous database work (Gate H.40). Without a trusted client address (no reverse proxy is chosen,
// decision 1) a per-client rate limit is impossible, and a storewide limit per minute would let one visitor lock
// every customer out. Instead, at most ANONYMOUS_CONCURRENCY anonymous requests use the database at once in this
// process (the pool has 10 connections, src/db/client.ts), a few more wait briefly, and the rest are refused at
// once. Anonymous traffic can therefore slow anonymous pages, but can never take the connections the Owner and the
// checkout need. Process-local: each application process has its own; no state is shared or stored.
// shortcut: fixed sizes per process; replace with per-client limits once hosting provides a trusted client address.

export const ANONYMOUS_CONCURRENCY = 4;
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

/**
 * The (unrouted) guest checkout's own, smaller bulkhead: a flood of catalogue reads cannot block ordering, nor the
 * reverse. Together the two leave at least four of the pool's ten connections to the Owner.
 */
export const CHECKOUT_CONCURRENCY = 2;
export const anonymousCheckoutWork: Bulkhead = createBulkhead(CHECKOUT_CONCURRENCY, 8, ANONYMOUS_WAIT_MS);
