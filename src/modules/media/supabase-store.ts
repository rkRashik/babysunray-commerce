import "server-only";
import * as z from "zod";
import { MAX_UPLOAD_BYTES } from "./images";
import { type MediaStore, STORAGE_KEY } from "./storage";

// A MediaStore (src/modules/media/storage.ts) over Supabase Storage's REST API, with a server-side secret key (never sent
// to a browser). The request and response contracts below were checked against Supabase Storage's own source
// (github.com/supabase/storage: routes object/createObject, getObject, deleteObject, listObjects, bucket/getBucket, and
// internal/errors) and the official client storage-js, on 2026-11-17 (Gate H.45). Tested only against an in-memory fake
// that follows those contracts: no real bucket has been used, so the staging suite (tests/staging) must pass first.
//
// Contract facts this relies on:
//  - Errors are a JSON body { statusCode: "<code as text>", code, error, message }. Domain errors are sent with HTTP 400
//    (500 stays 500); the real code is in the body: a duplicate key is statusCode "409" / code KeyAlreadyExists, a
//    missing object "404" / NoSuchKey, a missing or inaccessible bucket "404" / NoSuchBucket.
//  - Upload: POST /object/{bucket}/{key}; without `x-upsert: true` an existing object is never replaced. Answer { Key }.
//  - Private read: GET /object/authenticated/{bucket}/{key}. Delete one: DELETE /object/{bucket}/{key}.
//  - List: POST /object/list/{bucket} { prefix (required), limit, offset, sortBy, search }; folders have id null.
//  - Bucket: GET /bucket/{id} { id, name, public: boolean, versioning_status?, file_size_limit?, allowed_mime_types? }.
//
// Rules this adapter enforces itself:
//  - Only keys that match STORAGE_KEY (random hex plus jpg, png or webp) ever reach a URL; nothing a user typed.
//  - The content type is derived from the key's extension, never from a caller, and checked again on read.
//  - Objects are never overwritten; a retry that finds the same bytes already stored counts as done.
//  - A missing BUCKET is an error, never "no such photo" (a wrong bucket name must not look like an empty store).
//  - Downloads are read as a stream and cut off at the upload size limit, so memory stays bounded.
//  - Every request has a timeout; network errors, 5xx and 429 answers are retried twice with a pause.
//  - Errors name the operation and the status only: never the key, the URL or the secret key.

export type SupabaseStorageConfig = { origin: string; bucket: string; serviceKey: string };
type Fetch = typeof fetch;

const CONTENT_TYPES: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };
const TIMEOUT_MS = 15_000;
const ATTEMPTS = 3;
const LIST_PAGE = 100;
/** A listing never walks more than this many objects (100,000 at 100 per page); a larger bucket is reported, not truncated silently. */
const MAX_LIST_PAGES = 1_000;
const BUCKET = /^[a-z0-9][a-z0-9._-]{1,62}$/;

type Settings = Record<string, string | undefined>;

/**
 * Which secret this is, without verifying it: a new secret key (`sb_secret_...`) or a legacy JWT whose role claim is
 * service_role. Publishable and anon keys are refused: they cannot read a private bucket, and passing one would only
 * hide a configuration mistake.
 */
export function serviceKeyKind(key: string): "secret" | "legacy-service-role" | null {
  if (/^sb_secret_[A-Za-z0-9_-]{16,}$/.test(key)) return "secret";
  const parts = key.split(".");
  if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { role?: unknown };
    return claims.role === "service_role" ? "legacy-service-role" : null;
  } catch {
    return null;
  }
}

/** The configuration, or why there is none. Messages name variables and rules, never values. */
export function supabaseStorageConfig(env: Settings): { ok: true; config: SupabaseStorageConfig } | { ok: false; problems: { name: string; problem: string }[] } {
  const problems: { name: string; problem: string }[] = [];
  let origin = "";
  try {
    const url = new URL(env.SUPABASE_URL ?? "");
    const localhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(localhost && url.protocol === "http:" && env.NODE_ENV !== "production")) throw new Error("scheme");
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("shape");
    origin = url.origin;
  } catch {
    problems.push({ name: "SUPABASE_URL", problem: "SUPABASE_URL must be the project's https origin only, such as https://<project>.supabase.co." });
  }
  const bucket = env.SUPABASE_STORAGE_BUCKET ?? "";
  if (!BUCKET.test(bucket)) problems.push({ name: "SUPABASE_STORAGE_BUCKET", problem: "SUPABASE_STORAGE_BUCKET must be a bucket name (lowercase letters, digits, dot, dash, underscore)." });
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!serviceKeyKind(serviceKey)) {
    problems.push({ name: "SUPABASE_SERVICE_ROLE_KEY", problem: "SUPABASE_SERVICE_ROLE_KEY must be the project's secret key (sb_secret_...) or legacy service_role key; a publishable or anon key is refused. Server-side only." });
  }
  return problems.length ? { ok: false, problems } : { ok: true, config: { origin, bucket, serviceKey } };
}

export type BucketState = { reachable: boolean; private: boolean; versioned: boolean; fileSizeLimit: number | null; allowedMimeTypes: string[] | null };
export type SupabaseMediaStore = MediaStore & {
  /** The bucket's settings as Storage reports them; unreachable or malformed answers fail closed (not private). */
  bucketState(): Promise<BucketState>;
  /** True only for a reachable, private, unversioned bucket (a versioned one keeps deleted photos as markers). */
  bucketIsPrivate(): Promise<boolean>;
};

const errorBody = z.object({ statusCode: z.string().optional(), code: z.string().optional(), error: z.string().optional(), message: z.string().optional() });
type StorageError = z.infer<typeof errorBody>;
const uploadBody = z.object({ Key: z.string() });
const listItem = z.object({
  name: z.string().min(1),
  id: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  metadata: z.object({ size: z.number().int().nonnegative().optional(), mimetype: z.string().optional() }).passthrough().nullable().optional(),
});
const bucketBody = z.object({
  id: z.string(),
  public: z.boolean(),
  versioning_status: z.string().nullable().optional(),
  file_size_limit: z.number().nullable().optional(),
  allowed_mime_types: z.array(z.string()).nullable().optional(),
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const retryable = (status: number) => status >= 500 || status === 429;

async function storageError(response: Response): Promise<StorageError> {
  const parsed = errorBody.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data : {};
}
const isMissingObject = (e: StorageError) => e.code === "NoSuchKey" || (e.code === undefined && e.statusCode === "404" && e.error === "not_found");
const isMissingBucket = (e: StorageError) => e.code === "NoSuchBucket" || /bucket not found/i.test(e.message ?? "");
const isDuplicate = (e: StorageError) => e.code === "KeyAlreadyExists" || e.statusCode === "409" || e.error === "Duplicate";

/** The body as bytes, refused as soon as it passes `limit` (no full buffering of an oversized answer). */
async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Media storage read returned an object that is too large.");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Media storage read returned an object that is too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function supabaseMediaStore(config: SupabaseStorageConfig, doFetch: Fetch = fetch, pauseMs = 200, timeoutMs = TIMEOUT_MS): SupabaseMediaStore {
  const api = `${config.origin}/storage/v1`;
  // New secret keys go only in `apikey` (they are not JWTs); a legacy service_role JWT is also the bearer token.
  const auth: Record<string, string> = serviceKeyKind(config.serviceKey) === "secret" ? { apikey: config.serviceKey } : { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}` };
  const headers = (extra: Record<string, string> = {}) => ({ ...auth, ...extra });
  const bucket = encodeURIComponent(config.bucket);
  const objectPath = (key: string) => {
    if (typeof key !== "string" || !STORAGE_KEY.test(key)) throw new Error("Invalid media storage key.");
    return `${bucket}/${key}`;
  };

  /** One request with a timeout; retried on network errors, 5xx and 429 when `retry` is set; any other answer is returned. */
  async function call(operation: string, url: string, init: RequestInit, retry: boolean): Promise<Response> {
    let failure = `Media storage ${operation} failed.`;
    for (let attempt = 1; attempt <= (retry ? ATTEMPTS : 1); attempt += 1) {
      try {
        const response = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
        if (!retryable(response.status)) return response;
        failure = `Media storage ${operation} failed (status ${response.status}).`;
        await response.body?.cancel().catch(() => undefined);
      } catch {
        failure = `Media storage ${operation} could not reach the storage service.`;
      }
      if (attempt < ATTEMPTS && retry) await wait(pauseMs * attempt);
    }
    throw new Error(failure);
  }

  const refused = (operation: string, status: number, e: StorageError) =>
    new Error(isMissingBucket(e) ? `Media storage ${operation} failed: the bucket does not exist or the key cannot reach it.` : `Media storage ${operation} failed (status ${status}${e.code ? `, ${e.code}` : ""}).`);

  async function read(key: string): Promise<Buffer | null> {
    const expected = CONTENT_TYPES[objectPath(key).split(".").pop() ?? ""];
    const response = await call("read", `${api}/object/authenticated/${objectPath(key)}`, { method: "GET", headers: headers() }, true);
    if (!response.ok) {
      const e = await storageError(response);
      if (isMissingObject(e)) return null;
      throw refused("read", response.status, e);
    }
    const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (type !== expected) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Media storage read returned an unexpected content type.");
    }
    return boundedBody(response, MAX_UPLOAD_BYTES);
  }

  type Item = z.infer<typeof listItem>;
  async function listPage(extra: Record<string, unknown>, offset: number): Promise<Item[]> {
    const response = await call(
      "list",
      `${api}/object/list/${bucket}`,
      { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ prefix: "", limit: LIST_PAGE, offset, sortBy: { column: "name", order: "asc" }, ...extra }) },
      true,
    );
    if (!response.ok) throw refused("list", response.status, await storageError(response));
    const parsed = z.array(listItem).max(LIST_PAGE).safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new Error("Media storage list returned an unexpected answer.");
    return parsed.data;
  }
  async function listAll(extra: Record<string, unknown>, stop?: (item: Item) => boolean): Promise<Item[]> {
    const items: Item[] = [];
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const batch = await listPage(extra, page * LIST_PAGE);
      items.push(...batch);
      if (stop && batch.some(stop)) return items;
      if (batch.length < LIST_PAGE) return items;
    }
    throw new Error("Media storage list is longer than this check can read; nothing was concluded from it.");
  }

  async function bucketState(): Promise<BucketState> {
    const closed: BucketState = { reachable: false, private: false, versioned: false, fileSizeLimit: null, allowedMimeTypes: null };
    try {
      const response = await call("bucket check", `${api}/bucket/${bucket}`, { method: "GET", headers: headers() }, true);
      if (!response.ok) return closed;
      const parsed = bucketBody.safeParse(await response.json().catch(() => null));
      if (!parsed.success || parsed.data.id !== config.bucket) return closed;
      const b = parsed.data;
      return {
        reachable: true,
        private: b.public === false,
        versioned: b.versioning_status === "ENABLED" || b.versioning_status === "SUSPENDED",
        fileSizeLimit: b.file_size_limit ?? null,
        allowedMimeTypes: b.allowed_mime_types ?? null,
      };
    } catch {
      return closed;
    }
  }

  return {
    async put(key, data) {
      const path = objectPath(key);
      const contentType = CONTENT_TYPES[key.split(".")[1]];
      if (!contentType || data.length === 0 || data.length > MAX_UPLOAD_BYTES) throw new Error("Invalid media object.");
      const init = { method: "POST", headers: headers({ "content-type": contentType, "x-upsert": "false", "cache-control": "no-cache" }), body: new Uint8Array(data) };
      const response = await call("write", `${api}/object/${path}`, init, true);
      if (response.ok) {
        const parsed = uploadBody.safeParse(await response.json().catch(() => null));
        if (!parsed.success || parsed.data.Key !== `${config.bucket}/${key}`) throw new Error("Media storage write returned an unexpected answer.");
        return;
      }
      const e = await storageError(response);
      // Already there: an earlier attempt may have succeeded and lost its answer. Identical bytes mean it did.
      if (isDuplicate(e)) {
        const stored = await read(key);
        if (stored && stored.equals(data)) return;
        throw new Error("Media storage write refused: an object with this key already exists.");
      }
      throw refused("write", response.status, e);
    },
    read,
    async remove(key) {
      const response = await call("delete", `${api}/object/${objectPath(key)}`, { method: "DELETE", headers: headers() }, true);
      if (response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      const e = await storageError(response);
      if (isMissingObject(e)) return;
      throw refused("delete", response.status, e);
    },
    async entries() {
      return (await listAll({})).map((item) => item.name);
    },
    async info(name) {
      if (typeof name !== "string" || name === "" || name === "." || name === ".." || /[\\/]/.test(name)) throw new Error("Invalid media entry name.");
      // `search` narrows the listing; the exact name is matched here, whatever the service's search semantics are.
      const found = (await listAll({ search: name }, (item) => item.name === name)).find((item) => item.name === name);
      if (!found) return null;
      // A folder (no id) is not a photo; the manifest check reports it as unexpected.
      // No time reported: treat as just written, so the unreferenced-file clean-up keeps it (manifest.ts grace period).
      return { regularFile: typeof found.id === "string", modifiedMs: Date.parse(found.updated_at ?? found.created_at ?? "") || Date.now() };
    },
    bucketState,
    async bucketIsPrivate() {
      const state = await bucketState();
      return state.reachable && state.private && !state.versioned;
    },
  };
}
