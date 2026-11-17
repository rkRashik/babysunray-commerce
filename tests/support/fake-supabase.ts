// An in-memory stand-in for the parts of Supabase Storage's REST API the media adapter uses, as `fetch`. Fictional data
// only; no network. It follows the contract read from Supabase Storage's source on 2026-11-17 (see
// src/modules/media/supabase-store.ts): domain errors are HTTP 400 with the real code in the JSON body
// ({ statusCode: "409", code: "KeyAlreadyExists", error: "Duplicate" }, NoSuchKey, NoSuchBucket), uploads answer
// { Id, Key }, listing requires `prefix` and gives folders a null id, and the bucket answer has a boolean `public`.
// Passing tests against this fake is NOT proof of compatibility with the real service; tests/staging is.

import { Buffer } from "node:buffer";

export type Recorded = { method: string; path: string; headers: Record<string, string>; body?: string };
export type FakeSupabase = {
  fetch: typeof fetch;
  objects: Map<string, { data: Buffer; type: string; updated: string }>;
  requests: Recorded[];
  /** Called before each request; return a Response to answer with it, or throw to simulate a network error. */
  intercept: ((request: Recorded) => Response | undefined) | null;
  bucketPublic: boolean;
  versioning: string | null;
  /** Folder placeholders to list (entries with no id). */
  folders: string[];
};

/** A fictional legacy service_role key (JWT shape, never valid anywhere). */
export const FAKE_LEGACY_SERVICE_KEY = [
  Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url"),
  Buffer.from('{"role":"service_role","iss":"fictional"}').toString("base64url"),
  "ZmljdGlvbmFsLXNpZ25hdHVyZQ",
].join(".");
/** A fictional new-format secret key. */
export const FAKE_SECRET_KEY = "sb_secret_FICTIONALfictional0123456789";
export const FAKE_ANON_KEY = [Buffer.from('{"alg":"HS256"}').toString("base64url"), Buffer.from('{"role":"anon"}').toString("base64url"), "c2ln"].join(".");

const storageError = (statusCode: string, code: string, error: string, message: string) =>
  new Response(JSON.stringify({ statusCode, code, error, message }), { status: statusCode === "500" ? 500 : 400, headers: { "content-type": "application/json" } });

export function fakeSupabase(bucket = "photos"): FakeSupabase {
  const state: FakeSupabase = { objects: new Map(), requests: [], intercept: null, bucketPublic: false, versioning: null, folders: [], fetch: undefined as unknown as typeof fetch };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  state.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init?.body ? Buffer.from(init.body as Uint8Array) : undefined;
    const recorded: Recorded = { method: init?.method ?? "GET", path: url.pathname, headers, body: body?.toString("latin1") };
    state.requests.push(recorded);
    const injected = state.intercept?.(recorded);
    if (injected) return injected;
    const rest = url.pathname.slice("/storage/v1/".length);
    const [kind, ...parts] = rest.split("/");
    if (kind === "bucket") {
      if (parts[0] !== bucket) return storageError("404", "NoSuchBucket", "Bucket not found", "Bucket not found");
      return json(200, { id: bucket, name: bucket, public: state.bucketPublic, versioning_status: state.versioning, file_size_limit: null, allowed_mime_types: null, created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z" });
    }
    if (kind !== "object") return json(404, { statusCode: "404", error: "not_found", message: "Route not found" });
    const list = parts[0] === "list";
    const authenticated = parts[0] === "authenticated";
    const [b, ...keyParts] = list || authenticated ? parts.slice(1) : parts;
    if (b !== bucket) return storageError("404", "NoSuchBucket", "Bucket not found", "Bucket not found");
    const key = keyParts.join("/");
    if (list) {
      const parsed = JSON.parse(String(init?.body)) as { prefix?: string; search?: string; limit?: number; offset?: number };
      if (typeof parsed.prefix !== "string") return json(400, { statusCode: "400", error: "FST_ERR_VALIDATION", message: "body must have required property 'prefix'" });
      const { search = "", limit = 100, offset = 0 } = parsed;
      const names = [...state.objects.keys(), ...state.folders].filter((n) => n.startsWith(search)).sort();
      return json(
        200,
        names.slice(offset, offset + limit).map((name) => {
          const object = state.objects.get(name);
          return { name, id: object ? `id-${name}` : null, updated_at: object?.updated ?? null, created_at: object?.updated ?? null, last_accessed_at: null, metadata: object ? { size: object.data.length, mimetype: object.type } : null };
        }),
      );
    }
    if (recorded.method === "GET" && authenticated) {
      const found = state.objects.get(key);
      return found ? new Response(new Uint8Array(found.data), { status: 200, headers: { "content-type": found.type, "content-length": String(found.data.length) } }) : storageError("404", "NoSuchKey", "not_found", "Object not found");
    }
    if (recorded.method === "POST") {
      if (state.objects.has(key) && headers["x-upsert"] !== "true") return storageError("409", "KeyAlreadyExists", "Duplicate", "The resource already exists");
      state.objects.set(key, { data: body ?? Buffer.alloc(0), type: headers["content-type"], updated: new Date().toISOString() });
      return json(200, { Id: `id-${key}`, Key: `${bucket}/${key}` });
    }
    if (recorded.method === "DELETE") {
      if (!state.objects.delete(key)) return storageError("404", "NoSuchKey", "not_found", "Object not found");
      return json(200, { message: "Successfully deleted" });
    }
    return json(404, { statusCode: "404", error: "not_found", message: "Route not found" });
  }) as typeof fetch;
  return state;
}
