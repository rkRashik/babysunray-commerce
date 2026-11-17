import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { configuredMediaStore } from "../../src/modules/media/provider";
import { supabaseMediaStore, supabaseStorageConfig } from "../../src/modules/media/supabase-store";
import { fakeSupabase } from "../support/fake-supabase";

// The Supabase Storage media adapter against an in-memory fake of its REST API (Gate H.44). No real bucket, project or key.

const KEY = "00112233445566778899aabbccddeeff.png";
const config = { origin: "https://project.example.test", bucket: "photos", serviceKey: "fictional-service-key-0123456789" };
const png = Buffer.from("fictional image bytes");
const make = (pauseMs = 0) => {
  const server = fakeSupabase();
  return { server, store: supabaseMediaStore(config, server.fetch, pauseMs) };
};

describe("configuration", () => {
  const env = { SUPABASE_URL: "https://project.example.test", SUPABASE_STORAGE_BUCKET: "photos", SUPABASE_SERVICE_ROLE_KEY: "fictional-service-key-0123456789" };
  it("accepts a project origin, a bucket name and a key", () => {
    expect(supabaseStorageConfig(env)).toMatchObject({ ok: true, config: { origin: "https://project.example.test", bucket: "photos" } });
  });
  it("names each wrong variable and never prints a value", () => {
    const result = supabaseStorageConfig({ SUPABASE_URL: "http://project.example.test/x?k=secretvalue", SUPABASE_STORAGE_BUCKET: "Bad Bucket", SUPABASE_SERVICE_ROLE_KEY: "short" });
    expect(result.ok).toBe(false);
    const text = JSON.stringify(result);
    expect(text).toContain("SUPABASE_URL");
    expect(text).toContain("SUPABASE_STORAGE_BUCKET");
    expect(text).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(text).not.toMatch(/secretvalue|Bad Bucket/);
  });
  it("plain http is accepted only for localhost outside production", () => {
    expect(supabaseStorageConfig({ ...env, SUPABASE_URL: "http://localhost:54321" }).ok).toBe(true);
    expect(supabaseStorageConfig({ ...env, SUPABASE_URL: "http://localhost:54321", NODE_ENV: "production" }).ok).toBe(false);
  });
  it("the provider is chosen explicitly: unknown values are refused, local stays the default", () => {
    expect(configuredMediaStore({ ...env, MEDIA_STORAGE_PROVIDER: "supabse" }, process.cwd())).toEqual({ ok: false, problem: "MEDIA_STORAGE_PROVIDER must be local or supabase." });
    expect(configuredMediaStore({ MEDIA_STORAGE_PROVIDER: "supabase" }, process.cwd())).toMatchObject({ ok: false });
    expect(configuredMediaStore({ ...env, MEDIA_STORAGE_PROVIDER: "supabase" }, process.cwd())).toMatchObject({ ok: true, provider: "supabase" });
    expect(configuredMediaStore({}, process.cwd())).toMatchObject({ ok: false });
  });
});

describe("put and read", () => {
  it("stores a file once with the content type of its extension, never overwriting, and reads it back by the private route", async () => {
    const { server, store } = make();
    await store.put(KEY, png);
    expect(server.objects.get(KEY)?.type).toBe("image/png");
    const write = server.requests[0];
    expect(write).toMatchObject({ method: "POST", path: `/storage/v1/object/photos/${KEY}` });
    expect(write.headers["x-upsert"]).toBe("false");
    expect((await store.read(KEY))?.equals(png)).toBe(true);
    // Reads use the authenticated route: the object is never fetched through the public URL.
    expect(server.requests.at(-1)?.path).toBe(`/storage/v1/object/authenticated/photos/${KEY}`);
    expect(server.requests.every((r) => r.path.startsWith("/storage/v1/") && !r.path.includes("/object/public/"))).toBe(true);
  });
  it("a missing object reads as null", async () => {
    expect(await make().store.read(KEY)).toBeNull();
  });
  it("refuses to overwrite a different object under the same key", async () => {
    const { store } = make();
    await store.put(KEY, png);
    await expect(store.put(KEY, Buffer.from("other bytes"))).rejects.toThrow(/already exists/);
    expect((await store.read(KEY))?.equals(png)).toBe(true);
  });
  it("only keys made by newStorageKey reach a URL; no name, path or extension a caller invents", async () => {
    const { server, store } = make();
    for (const bad of ["../x.png", "a/b.png", "00112233445566778899aabbccddeeff.gif", "00112233445566778899AABBCCDDEEFF.png", `${KEY}?x=1`, "", "folder/"]) {
      await expect(store.put(bad, png)).rejects.toThrow();
      await expect(store.read(bad)).rejects.toThrow();
      await expect(store.remove(bad)).rejects.toThrow();
    }
    expect(server.requests).toEqual([]);
  });
  it("refuses empty and oversized objects", async () => {
    const { store } = make();
    await expect(store.put(KEY, Buffer.alloc(0))).rejects.toThrow();
    await expect(store.put(KEY, Buffer.alloc(10 * 1024 * 1024 + 1))).rejects.toThrow();
  });
  it("a read that returns a huge object is refused", async () => {
    const { server, store } = make();
    server.intercept = () => new Response(new Uint8Array(1), { status: 200, headers: { "content-length": String(11 * 1024 * 1024) } });
    await expect(store.read(KEY)).rejects.toThrow(/too large/);
  });
});

describe("failures and retries", () => {
  it("a lost answer after a successful write is recovered: the retry finds identical bytes and counts as done", async () => {
    const { server, store } = make();
    let first = true;
    server.intercept = (request) => {
      if (request.method === "POST" && first) {
        first = false;
        server.objects.set(KEY, { data: png, type: "image/png", updated: new Date().toISOString() });
        return new Response("gateway", { status: 502 });
      }
      return undefined;
    };
    await expect(store.put(KEY, png)).resolves.toBeUndefined();
  });
  it("a network error is retried, then reported without the key, the URL or the service key", async () => {
    const { server, store } = make();
    server.intercept = () => {
      throw new Error(`socket closed ${config.serviceKey} ${KEY}`);
    };
    const error = await store.read(KEY).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toMatch(/fictional-service-key|0011|project\.example/);
    expect(server.requests.length).toBe(3);
  });
  it("a 4xx answer (for example an expired key) is not retried and does not leak", async () => {
    const { server, store } = make();
    server.intercept = () => new Response("{}", { status: 403 });
    await expect(store.put(KEY, png)).rejects.toThrow(/status 403/);
    expect(server.requests.length).toBe(1);
  });
  it("a request that hangs is cut off by the timeout instead of waiting for ever", async () => {
    const hanging = ((_: unknown, init?: RequestInit) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
    const store = supabaseMediaStore(config, hanging, 0, 50);
    const started = Date.now();
    await expect(store.read(KEY)).rejects.toThrow(/could not reach/);
    // Three attempts of 50 ms each (15 s each in production).
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });
  it("remove ignores a missing object but reports a real failure", async () => {
    const { server, store } = make();
    await expect(store.remove(KEY)).resolves.toBeUndefined();
    server.intercept = () => new Response("{}", { status: 403 });
    await expect(store.remove(KEY)).rejects.toThrow(/delete failed/);
  });
});

describe("listing and metadata", () => {
  it("lists every entry across pages, tells files from folders, and reports when a file last changed", async () => {
    const { server, store } = make();
    server.folders.push("folder-entry");
    const keys = Array.from({ length: 205 }, () => `${randomBytes(16).toString("hex")}.jpg`);
    for (const k of keys) server.objects.set(k, { data: png, type: "image/jpeg", updated: "2026-11-01T10:00:00.000Z" });
    const names = await store.entries();
    expect(names.length).toBe(206);
    expect(names).toContain("folder-entry");
    expect(await store.info(keys[0])).toEqual({ regularFile: true, modifiedMs: Date.parse("2026-11-01T10:00:00.000Z") });
    expect(await store.info("folder-entry")).toMatchObject({ regularFile: false });
    expect(await store.info("0123456789abcdef0123456789abcdef.png")).toBeNull();
    await expect(store.info("a/b")).rejects.toThrow();
  });
});

describe("bucket privacy", () => {
  it("is private only when the service says so; public, unreadable or failing all count as not private", async () => {
    const { server, store } = make();
    expect(await store.bucketIsPrivate()).toBe(true);
    server.bucketPublic = true;
    expect(await store.bucketIsPrivate()).toBe(false);
    server.intercept = () => new Response("{}", { status: 404 });
    expect(await store.bucketIsPrivate()).toBe(false);
    server.intercept = () => {
      throw new Error("down");
    };
    expect(await store.bucketIsPrivate()).toBe(false);
  });
});
