import { describe, expect, it } from "vitest";
import { ANONYMOUS_CONCURRENCY, createBulkhead } from "../../src/modules/rate-limit/bulkhead";
import { POOL_LIMITS } from "../../src/db/client";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe("bulkhead for anonymous database work", () => {
  it("runs at most `limit` at once, queues a few, refuses the rest at once, and never exceeds the limit", async () => {
    const run = createBulkhead(2, 1, 1_000);
    let active = 0;
    let peak = 0;
    const gates = [deferred(), deferred(), deferred()];
    const work = (i: number) => async () => {
      active += 1;
      peak = Math.max(peak, active);
      await gates[i].promise;
      active -= 1;
      return i;
    };
    const first = run(work(0));
    const second = run(work(1));
    const queued = run(work(2));
    expect(await run(async () => "refused")).toEqual({ ok: false });
    gates[0].resolve();
    expect(await first).toEqual({ ok: true, value: 0 });
    gates[1].resolve();
    gates[2].resolve();
    expect(await Promise.all([second, queued])).toEqual([{ ok: true, value: 1 }, { ok: true, value: 2 }]);
    expect(peak).toBe(2);
    // The slots are free again.
    expect(await run(async () => "again")).toEqual({ ok: true, value: "again" });
  });

  it("a waiter gives up after the wait, and a failing task frees its slot", async () => {
    const run = createBulkhead(1, 1, 30);
    const gate = deferred();
    const holder = run(() => gate.promise);
    expect(await run(async () => "late")).toEqual({ ok: false });
    gate.resolve();
    await holder;
    await expect(run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await run(async () => "free")).toEqual({ ok: true, value: "free" });
  });

  it("leaves most pool connections to the Owner and the checkout", () => {
    // The pool has the driver's default of 10 connections (src/db/client.ts).
    expect(ANONYMOUS_CONCURRENCY).toBeLessThan(10 / 2);
    expect(POOL_LIMITS.connectionTimeoutMillis).toBeGreaterThan(0);
  });
});
