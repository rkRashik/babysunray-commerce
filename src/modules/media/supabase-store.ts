import "server-only";
import { MAX_UPLOAD_BYTES } from "./images";
import { type MediaStore, STORAGE_KEY } from "./storage";

// A MediaStore (src/modules/media/storage.ts) over Supabase Storage's REST API, with the server-side service key (never
// sent to a browser). Written against Supabase's documented Storage API and tested only with a mocked `fetch`: no
// real bucket has been used (Gate H.44), so it needs a staging check before any real use (docs/operations/infrastructure.md).
//
// Rules this adapter enforces itself:
//  - Only keys that match STORAGE_KEY (random hex plus jpg, png or webp) ever reach a URL; nothing a user typed.
//  - The content type is derived from the key's extension, never from a caller.
//  - Objects are never overwritten (x-upsert: false); a retry that finds the same bytes already stored counts as done.
//  - Reads are authenticated (the private-object route), so a photo is never public because its file exists. The
//    bucket must be private: `bucketIsPrivate()` is checked by readiness and refused when it is public.
//  - Every request has a timeout; reads, deletes and listings retry twice on a network error or a 5xx answer.
//  - Errors name the operation and the status only: never the key, the URL or the service key.

export type SupabaseStorageConfig = { origin: string; bucket: string; serviceKey: string };
type Fetch = typeof fetch;

const CONTENT_TYPES: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };
const TIMEOUT_MS = 15_000;
const ATTEMPTS = 3;
const LIST_PAGE = 100;
const BUCKET = /^[a-z0-9][a-z0-9._-]{1,62}$/;

type Settings = Record<string, string | undefined>;

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
  if (serviceKey.length < 20 || /\s/.test(serviceKey) || /change_me/i.test(serviceKey)) problems.push({ name: "SUPABASE_SERVICE_ROLE_KEY", problem: "SUPABASE_SERVICE_ROLE_KEY is missing or not a key. Server-side only; never public." });
  return problems.length ? { ok: false, problems } : { ok: true, config: { origin, bucket, serviceKey } };
}

export type SupabaseMediaStore = MediaStore & {
  /** True when the bucket is private. False when it is public or its state cannot be read (fail closed). */
  bucketIsPrivate(): Promise<boolean>;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function supabaseMediaStore(config: SupabaseStorageConfig, doFetch: Fetch = fetch, pauseMs = 200, timeoutMs = TIMEOUT_MS): SupabaseMediaStore {
  const api = `${config.origin}/storage/v1`;
  const headers = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${config.serviceKey}`, apikey: config.serviceKey, ...extra });
  const objectPath = (key: string) => {
    if (typeof key !== "string" || !STORAGE_KEY.test(key)) throw new Error("Invalid media storage key.");
    return `${encodeURIComponent(config.bucket)}/${key}`;
  };

  /** One request with a timeout. Network errors and 5xx answers are retried when `retry` is set; others are returned. */
  async function call(operation: string, url: string, init: RequestInit, retry: boolean): Promise<Response> {
    let failure = `Media storage ${operation} failed.`;
    for (let attempt = 1; attempt <= (retry ? ATTEMPTS : 1); attempt += 1) {
      try {
        const response = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
        if (response.status < 500) return response;
        failure = `Media storage ${operation} failed (status ${response.status}).`;
        await response.body?.cancel().catch(() => undefined);
      } catch {
        failure = `Media storage ${operation} could not reach the storage service.`;
      }
      if (attempt < ATTEMPTS && retry) await wait(pauseMs * attempt);
    }
    throw new Error(failure);
  }

  // Supabase answers a missing object with 404, or with 400 and a body whose statusCode is "404".
  const isMissing = async (response: Response) => {
    if (response.status === 404) return true;
    if (response.status !== 400) return false;
    return (await response.json().catch(() => null))?.statusCode === "404";
  };

  async function read(key: string): Promise<Buffer | null> {
    const response = await call("read", `${api}/object/authenticated/${objectPath(key)}`, { method: "GET", headers: headers() }, true);
    if (await isMissing(response.clone())) return null;
    if (!response.ok) throw new Error(`Media storage read failed (status ${response.status}).`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_UPLOAD_BYTES) throw new Error("Media storage read returned an object that is too large.");
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > MAX_UPLOAD_BYTES) throw new Error("Media storage read returned an object that is too large.");
    return data;
  }

  type Item = { name: string; id: string | null; updated_at?: string | null; created_at?: string | null };
  async function list(extra: Record<string, unknown>, offset: number): Promise<Item[]> {
    const response = await call(
      "list",
      `${api}/object/list/${encodeURIComponent(config.bucket)}`,
      { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ prefix: "", limit: LIST_PAGE, offset, sortBy: { column: "name", order: "asc" }, ...extra }) },
      true,
    );
    if (!response.ok) throw new Error(`Media storage list failed (status ${response.status}).`);
    const body: unknown = await response.json().catch(() => null);
    if (!Array.isArray(body)) throw new Error("Media storage list returned an unexpected answer.");
    return body.filter((item): item is Item => typeof item?.name === "string");
  }

  return {
    async put(key, data) {
      const extension = key.split(".")[1];
      const contentType = CONTENT_TYPES[extension];
      if (!contentType || data.length === 0 || data.length > MAX_UPLOAD_BYTES) throw new Error("Invalid media object.");
      const url = `${api}/object/${objectPath(key)}`;
      const init = { method: "POST", headers: headers({ "content-type": contentType, "x-upsert": "false" }), body: new Uint8Array(data) };
      const response = await call("write", url, init, true);
      if (response.ok) return;
      // Already there: the first attempt may have succeeded and lost its answer. Identical bytes mean it did.
      const duplicate = response.status === 409 || (response.status === 400 && /exist|duplicate/i.test(await response.text().catch(() => "")));
      if (duplicate) {
        const stored = await read(key);
        if (stored && stored.equals(data)) return;
        throw new Error("Media storage write refused: an object with this key already exists.");
      }
      throw new Error(`Media storage write failed (status ${response.status}).`);
    },
    read,
    async remove(key) {
      const response = await call("delete", `${api}/object/${objectPath(key)}`, { method: "DELETE", headers: headers() }, true);
      if (response.ok || (await isMissing(response))) return;
      throw new Error(`Media storage delete failed (status ${response.status}).`);
    },
    async entries() {
      const names: string[] = [];
      for (let offset = 0; ; offset += LIST_PAGE) {
        const page = await list({}, offset);
        names.push(...page.map((item) => item.name));
        if (page.length < LIST_PAGE) return names;
      }
    },
    async info(name) {
      if (typeof name !== "string" || name === "" || name === "." || name === ".." || /[\\/]/.test(name)) throw new Error("Invalid media entry name.");
      const found = (await list({ search: name }, 0)).find((item) => item.name === name);
      if (!found) return null;
      // A folder (no id) is not a photo; the manifest check reports it as unexpected.
      return { regularFile: found.id !== null && found.id !== undefined, modifiedMs: Date.parse(found.updated_at ?? found.created_at ?? "") || 0 };
    },
    async bucketIsPrivate() {
      try {
        const response = await call("bucket check", `${api}/bucket/${encodeURIComponent(config.bucket)}`, { method: "GET", headers: headers() }, true);
        if (!response.ok) return false;
        return (await response.json().catch(() => null))?.public === false;
      } catch {
        return false;
      }
    },
  };
}
