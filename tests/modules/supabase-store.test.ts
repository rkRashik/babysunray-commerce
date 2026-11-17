import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { configuredMediaStore } from "../../src/modules/media/provider";
import { serviceKeyKind, supabaseMediaStore, supabaseStorageConfig } from "../../src/modules/media/supabase-store";
import { FAKE_ANON_KEY, FAKE_LEGACY_SERVICE_KEY, FAKE_SECRET_KEY, fakeSupabase } from "../support/fake-supabase";

// The Supabase Storage media adapter against an in-memory fake of its REST API (Gates H.44, H.45). The fake follows the
// contract read from Supabase Storage's source; no real bucket, project or key is used, so this is not proof of real
// compatibility (tests/staging is).

const KEY = "00112233445566778899aabbccddeeff.png";
const config = { origin: "https://project.example.test", bucket: "photos", serviceKey: FAKE_LEGACY_SERVICE_KEY };
const png = Buffer.from("fictional image bytes");
const make = (serviceKey = FAKE_LEGACY_SERVICE_KEY, bucket = "photos") => {
  const server = fakeSupabase();
  return { server, store: supabaseMediaStore({ ...config, serviceKey, bucket }, server.fetch, 0, 50) };
};

describe("configuration", () => {
  const env = { SUPABASE_URL: "https://project.example.test", SUPABASE_STORAGE_BUCKET: "photos", SUPABASE_SERVICE_ROLE_KEY: FAKE_SECRET_KEY };
  it("accepts a project origin, a bucket name and a secret or legacy service_role key", () => {
    expect(supabaseStorageConfig(env)).toMatchObject({ ok: true, config: { origin: "https://project.example.test", bucket: "photos" } });
    expect(supabaseStorageConfig({ ...env, SUPABASE_SERVICE_ROLE_KEY: FAKE_LEGACY_SERVICE_KEY }).ok).toBe(true);
  });
  it("refuses a publishable or anon key, and anything that is not a key", () => {
    expect(serviceKeyKind(FAKE_ANON_KEY)).toBeNull();
    for (const key of [FAKE_ANON_KEY, "sb_publishable_FICTIONAL0123456789abc", "short", "CHANGE_ME", "a.b", ""]) expect(supabaseStorageConfig({ ...env, SUPABASE_SERVICE_ROLE_KEY: key }).ok).toBe(false);
  });
  it("names each wrong variable and never prints a value", () => {
    const result = supabaseStorageConfig({ SUPABASE_URL: "http://project.example.test/x?k=secretvalue", SUPABASE_STORAGE_BUCKET: "Bad Bucket", SUPABASE_SERVICE_ROLE_KEY: "short-secret-value" });
    expect(result.ok).toBe(false);
    const text = JSON.stringify(result);
    for (const name of ["SUPABASE_URL", "SUPABASE_STORAGE_BUCKET", "SUPABASE_SERVICE_ROLE_KEY"]) expect(text).toContain(name);
    expect(text).not.toMatch(/secretvalue|Bad Bucket|short-secret-value/);
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

describe("credentials on the wire", () => {
  it("a new secret key goes only in apikey (it is not a JWT); a legacy service_role key is also the bearer token", async () => {
    const secret = make(FAKE_SECRET_KEY);
    await secret.store.read(KEY);
    expect(secret.server.requests[0].headers.apikey).toBe(FAKE_SECRET_KEY);
    expect(secret.server.requests[0].headers.authorization).toBeUndefined();
    const legacy = make();
    await legacy.store.read(KEY);
    expect(legacy.server.requests[0].headers).toMatchObject({ apikey: FAKE_LEGACY_SERVICE_KEY, authorization: `Bearer ${FAKE_LEGACY_SERVICE_KEY}` });
  });
});

describe("put and read", () => {
  it("stores a file once with the content type of its extension, never overwriting, and reads it back by the private route", async () => {
    const { server, store } = make();
    await store.put(KEY, png);
    expect(server.objects.get(KEY)?.type).toBe("image/png");
    expect(server.requests[0]).toMatchObject({ method: "POST", path: `/storage/v1/object/photos/${KEY}` });
    expect(server.requests[0].headers["x-upsert"]).toBe("false");
    expect((await store.read(KEY))?.equals(png)).toBe(true);
    expect(server.requests.at(-1)?.path).toBe(`/storage/v1/object/authenticated/photos/${KEY}`);
    expect(server.requests.every((r) => !r.path.includes("/object/public/") && !r.path.includes("/sign/"))).toBe(true);
  });
  it("a missing object reads as null; a missing bucket is an error, never an empty store", async () => {
    expect(await make().store.read(KEY)).toBeNull();
    const wrongBucket = make(FAKE_LEGACY_SERVICE_KEY, "no-such-bucket");
    await expect(wrongBucket.store.read(KEY)).rejects.toThrow(/bucket does not exist/);
    await expect(wrongBucket.store.remove(KEY)).rejects.toThrow(/bucket does not exist/);
    await expect(wrongBucket.store.put(KEY, png)).rejects.toThrow(/bucket does not exist/);
    await expect(wrongBucket.store.entries()).rejects.toThrow(/bucket does not exist/);
  });
  it("refuses to overwrite a different object under the same key (HTTP 400, KeyAlreadyExists)", async () => {
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
  it("refuses empty and oversized objects before sending anything", async () => {
    const { server, store } = make();
    await expect(store.put(KEY, Buffer.alloc(0))).rejects.toThrow();
    await expect(store.put(KEY, Buffer.alloc(10 * 1024 * 1024 + 1))).rejects.toThrow();
    expect(server.requests).toEqual([]);
  });
  it("an upload answer that does not name this object is an error", async () => {
    const { server, store } = make();
    server.intercept = (r) => (r.method === "POST" ? new Response(JSON.stringify({ Key: "photos/another.png" }), { status: 200 }) : undefined);
    await expect(store.put(KEY, png)).rejects.toThrow(/unexpected answer/);
  });
});

describe("bounded, validated downloads", () => {
  it("a declared size above the limit is refused without reading the body", async () => {
    const { server, store } = make();
    server.intercept = () => new Response(new Uint8Array(1), { status: 200, headers: { "content-type": "image/png", "content-length": String(11 * 1024 * 1024) } });
    await expect(store.read(KEY)).rejects.toThrow(/too large/);
  });
  it("a body that grows past the limit without a declared size is cut off while streaming", async () => {
    const { server, store } = make();
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1024 * 1024;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    server.intercept = () => new Response(endless, { status: 200, headers: { "content-type": "image/png" } });
    await expect(store.read(KEY)).rejects.toThrow(/too large/);
    expect(sent).toBeLessThan(13 * 1024 * 1024);
  });
  it("an object served with another content type is refused", async () => {
    const { server, store } = make();
    server.intercept = () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
    await expect(store.read(KEY)).rejects.toThrow(/content type/);
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
  it("a network error is retried, then reported without the key, the URL or the secret key", async () => {
    const { server, store } = make();
    server.intercept = () => {
      throw new Error(`socket closed ${FAKE_LEGACY_SERVICE_KEY} ${KEY}`);
    };
    const error = await store.read(KEY).catch((e: Error) => e);
    expect(String((error as Error).message)).not.toMatch(/eyJ|0011|project\.example/);
    expect(server.requests.length).toBe(3);
  });
  it("429 (Storage's database slowdown) is retried like a 5xx", async () => {
    const { server, store } = make();
    let calls = 0;
    server.intercept = () => (calls++ < 2 ? new Response("{}", { status: 429 }) : undefined);
    expect(await store.read(KEY)).toBeNull();
    expect(calls).toBe(3);
  });
  it("a 4xx answer (for example an expired key) is not retried and does not leak", async () => {
    const { server, store } = make();
    server.intercept = () => new Response(JSON.stringify({ statusCode: "403", code: "AccessDenied", error: "Unauthorized", message: "invalid signature" }), { status: 400 });
    await expect(store.put(KEY, png)).rejects.toThrow(/status 400, AccessDenied/);
    expect(server.requests.length).toBe(1);
  });
  it("a request that hangs is cut off by the timeout instead of waiting for ever", async () => {
    const hanging = ((_: unknown, init?: RequestInit) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
    const store = supabaseMediaStore(config, hanging, 0, 50);
    const started = Date.now();
    await expect(store.read(KEY)).rejects.toThrow(/could not reach/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });
  it("remove ignores a missing object (NoSuchKey) but reports a real failure", async () => {
    const { server, store } = make();
    await expect(store.remove(KEY)).resolves.toBeUndefined();
    server.intercept = () => new Response("{}", { status: 403 });
    await expect(store.remove(KEY)).rejects.toThrow(/delete failed/);
  });
});

describe("listing and metadata", () => {
  it("lists every entry across pages, tells files from folders, and finds one entry exactly, past the first page", async () => {
    const { server, store } = make();
    server.folders.push("folder-entry");
    const keys = Array.from({ length: 205 }, () => `${randomBytes(16).toString("hex")}.jpg`).sort();
    for (const k of keys) server.objects.set(k, { data: png, type: "image/jpeg", updated: "2026-11-01T10:00:00.000Z" });
    const names = await store.entries();
    expect(names.length).toBe(206);
    expect(new Set(names).size).toBe(206);
    expect(await store.info(keys[204])).toEqual({ regularFile: true, modifiedMs: Date.parse("2026-11-01T10:00:00.000Z") });
    expect(await store.info("folder-entry")).toMatchObject({ regularFile: false });
    expect(await store.info("0123456789abcdef0123456789abcdef.png")).toBeNull();
    await expect(store.info("a/b")).rejects.toThrow();
    // Every listing request carries the required prefix.
    expect(server.requests.filter((r) => r.path.includes("/object/list/")).every((r) => JSON.parse(r.body ?? "{}").prefix === "")).toBe(true);
  });
  it("a listing answer of the wrong shape is an error, not an empty bucket", async () => {
    const { server, store } = make();
    for (const body of [{ error: "x" }, [{ id: "1" }], [{ name: 5 }], "nonsense"]) {
      server.intercept = () => new Response(JSON.stringify(body), { status: 200 });
      await expect(store.entries()).rejects.toThrow(/unexpected answer/);
    }
  });
});

describe("bucket state", () => {
  it("is private only when the service says public: false for this very bucket, and the bucket is not versioned", async () => {
    const { server, store } = make();
    expect(await store.bucketIsPrivate()).toBe(true);
    server.bucketPublic = true;
    expect(await store.bucketIsPrivate()).toBe(false);
    server.bucketPublic = false;
    server.versioning = "ENABLED";
    expect(await store.bucketIsPrivate()).toBe(false);
    expect(await store.bucketState()).toMatchObject({ reachable: true, private: true, versioned: true });
  });
  it("fails closed: a missing bucket, an odd answer, another bucket's answer or no answer all count as not private", async () => {
    expect(await make(FAKE_LEGACY_SERVICE_KEY, "no-such-bucket").store.bucketIsPrivate()).toBe(false);
    const { server, store } = make();
    for (const respond of [() => new Response("{}", { status: 200 }), () => new Response(JSON.stringify({ id: "other", public: false }), { status: 200 }), () => new Response(JSON.stringify({ id: "photos", public: "false" }), { status: 200 })]) {
      server.intercept = respond;
      expect(await store.bucketIsPrivate()).toBe(false);
    }
    server.intercept = () => {
      throw new Error("down");
    };
    expect(await store.bucketIsPrivate()).toBe(false);
  });
});

describe("the configured store writes only to a confirmed-private bucket", () => {
  it("refuses uploads to a public or versioned bucket, and stores once the bucket is private", async () => {
    const { vi } = await import("vitest");
    const server = fakeSupabase();
    vi.stubGlobal("fetch", server.fetch);
    try {
      const env = { MEDIA_STORAGE_PROVIDER: "supabase", SUPABASE_URL: "https://guard.example.test", SUPABASE_STORAGE_BUCKET: "photos", SUPABASE_SERVICE_ROLE_KEY: FAKE_SECRET_KEY };
      server.bucketPublic = true;
      const configured = configuredMediaStore(env, process.cwd());
      if (!configured.ok) throw new Error("expected a store");
      await expect(configured.store.put(KEY, png)).rejects.toThrow(/not confirmed private/);
      expect(server.objects.size).toBe(0);
      // A failed check is not remembered: once the bucket is private, the next upload goes through.
      server.bucketPublic = false;
      await configured.store.put(KEY, png);
      expect(server.objects.size).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
