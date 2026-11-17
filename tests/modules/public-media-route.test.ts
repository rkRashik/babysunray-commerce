import { beforeEach, describe, expect, it, vi } from "vitest";

// The routed photo endpoint is CLOSED (Gate H.49): with the real launch gate it answers 503 and never touches the
// database or the photo store, for any id, key or query. The mocks below throw if they are reached.

const touched = vi.fn();
vi.mock("@/db/client", () => ({
  getDb: () => {
    touched("database");
    throw new Error("the database was touched");
  },
}));
vi.mock("@/modules/media/provider", () => ({
  getMediaStore: () => {
    touched("store");
    throw new Error("the photo store was touched");
  },
}));

const { GET, HEAD, POST, DELETE } = await import("../../src/app/api/public/media/[mediaId]/route");
const call = (handler: typeof GET, id: string, query = "", method = "GET") => handler(new Request(`https://shop.example.test/api/public/media/${encodeURIComponent(id)}${query}`, { method }), { params: Promise.resolve({ mediaId: id }) });

beforeEach(() => touched.mockClear());

describe("GET /api/public/media/{id} with the real, closed launch gate", () => {
  it("answers 503 with no body before any database or storage access, whatever the id or query", async () => {
    const ids = ["0b8c7f5e-1b0a-4d0e-9a53-6a3f4b1c2d9e", "not-a-uuid", `${"a".repeat(32)}.jpg`, "../../etc/passwd", "' or '1'='1", ""];
    for (const id of ids) {
      for (const query of ["", "?w=320", "?w=abc", "?x=1&y=2"]) {
        const response = await call(GET, id, query);
        expect(response.status).toBe(503);
        expect(await response.text()).toBe("");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("content-type")).toBeNull();
      }
    }
    expect(touched).not.toHaveBeenCalled();
  });
  it("accepts GET only: other methods are refused with 405 and no access either", async () => {
    for (const [handler, method] of [[POST, "POST"], [DELETE, "DELETE"]] as const) {
      const response = await call(handler, "x", "", method);
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET");
    }
    expect((await call(HEAD, "x", "", "HEAD")).status).toBe(405);
    expect(touched).not.toHaveBeenCalled();
  });
});
