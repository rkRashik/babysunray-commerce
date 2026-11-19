import { describe, expect, it, vi } from "vitest";
import { ANONYMOUS_QUEUE, AUTH_CONCURRENCY } from "../../src/modules/rate-limit/bulkhead";

// The /api/auth route runs Better Auth's handler inside its own bulkhead (Gate H.42 review): a flood of anonymous
// sign-in requests is refused quickly instead of taking the connections the rest of Admin needs.

const held: (() => void)[] = [];
let calls = 0;
vi.mock("@/modules/auth/server", () => ({
  getAuth: () => ({
    handler: () => {
      calls += 1;
      return new Promise<Response>((resolve) => held.push(() => resolve(new Response("{}", { status: 200 }))));
    },
  }),
}));

const route = await import("../../src/app/api/auth/[...all]/route");
const post = () => route.POST(new Request("http://localhost:3000/api/auth/sign-in/email", { method: "POST", body: "{}" }));

describe("/api/auth bulkhead", () => {
  it("runs at most AUTH_CONCURRENCY requests at once, queues a few and refuses the rest at once with 503", async () => {
    const pending = Array.from({ length: AUTH_CONCURRENCY + ANONYMOUS_QUEUE }, post);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(AUTH_CONCURRENCY);
    const refused = await post();
    expect([refused.status, refused.headers.get("retry-after"), refused.headers.get("cache-control")]).toEqual([503, "1", "no-store"]);
    expect(calls).toBe(AUTH_CONCURRENCY);
    // Released, every queued request runs, one slot at a time.
    while (held.length || calls < pending.length) {
      held.shift()?.();
      await new Promise((r) => setTimeout(r, 1));
    }
    expect((await Promise.all(pending)).every((r) => r.status === 200)).toBe(true);
    expect(calls).toBe(pending.length);
  });
});
