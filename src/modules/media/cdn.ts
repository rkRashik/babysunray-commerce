import "server-only";
import { createHash } from "node:crypto";
import type { SettingProblem } from "../../db/pool-settings";

// Cloudinary as the delivery CDN for PUBLISHED product photos only (Gate H.57, ADR-0010). The private original stays in
// the MediaStore (local folder or Supabase Storage); nothing here reads or changes it. A copy is uploaded when a product
// is published and destroyed (with CDN invalidation) when it is withdrawn (cdn-sync.ts); a draft photo never reaches
// Cloudinary. Settings: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET (server only, never exposed to the browser)
// and optionally CLOUDINARY_FOLDER. None set means no CDN: nothing is uploaded and no CDN URL is produced.
//
// The public id contains the photo's id and the first 16 hex digits of its SHA-256, so a photo that is replaced gets a
// new URL and an old URL never serves different content: replacement needs no invalidation, and every URL can be cached
// for a long time. Only withdrawal needs a purge. Limit that cannot be removed: a copy already held by a browser or
// another cache outside Cloudinary stays there until it expires, and Cloudinary documents that an invalidation can take
// a few minutes to reach every CDN node. A withdrawn product's image can therefore stay visible to someone who has its
// exact URL for a short time after withdrawal; this is a limit of any CDN.

export type CdnConfig = { cloudName: string; apiKey: string; apiSecret: string; folder: string };
const CLOUD = /^[A-Za-z0-9][A-Za-z0-9_-]{1,62}$/;
const FOLDER = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*){0,3}$/;
export const DEFAULT_CDN_FOLDER = "babysunray/products";

/** `config: null` when no CLOUDINARY_* setting is present at all (photos are served without a CDN). */
export function cdnConfig(env: Record<string, string | undefined>): { ok: true; config: CdnConfig | null } | { ok: false; problems: SettingProblem[] } {
  const names = ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"] as const;
  if (![...names, "CLOUDINARY_FOLDER"].some((n) => env[n])) return { ok: true, config: null };
  const problems: SettingProblem[] = [];
  for (const name of names) if (!env[name]) problems.push({ name, problem: `${name} is required when the Cloudinary CDN is used.` });
  if (env.CLOUDINARY_CLOUD_NAME && !CLOUD.test(env.CLOUDINARY_CLOUD_NAME)) problems.push({ name: "CLOUDINARY_CLOUD_NAME", problem: "CLOUDINARY_CLOUD_NAME is not a valid cloud name." });
  if (env.CLOUDINARY_API_KEY && !/^[0-9]{6,20}$/.test(env.CLOUDINARY_API_KEY)) problems.push({ name: "CLOUDINARY_API_KEY", problem: "CLOUDINARY_API_KEY must be the numeric API key." });
  if (env.CLOUDINARY_API_SECRET && /\s/.test(env.CLOUDINARY_API_SECRET)) problems.push({ name: "CLOUDINARY_API_SECRET", problem: "CLOUDINARY_API_SECRET must not contain spaces." });
  const folder = env.CLOUDINARY_FOLDER || DEFAULT_CDN_FOLDER;
  if (!FOLDER.test(folder)) problems.push({ name: "CLOUDINARY_FOLDER", problem: "CLOUDINARY_FOLDER must be lowercase letters, digits, - and _, with / between up to four levels." });
  if (problems.length) return { ok: false, problems };
  return { ok: true, config: { cloudName: env.CLOUDINARY_CLOUD_NAME!, apiKey: env.CLOUDINARY_API_KEY!, apiSecret: env.CLOUDINARY_API_SECRET!, folder } };
}

/** The deterministic public id of a photo's CDN copy (see the header: it changes when the photo's content changes). */
export const cdnPublicId = (config: Pick<CdnConfig, "folder">, photo: { id: string; sha256: string }) => `${config.folder}/${photo.id}_${photo.sha256.slice(0, 16)}`;

/** Cloudinary's request signature: the sorted `name=value` pairs joined with &, then the API secret, hashed with SHA-1. */
export function signCloudinary(params: Record<string, string>, apiSecret: string): string {
  const text = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
  return createHash("sha1").update(text + apiSecret).digest("hex");
}

/** Never carries Cloudinary's response text or any setting: the status is enough to act on. */
export class CdnError extends Error {
  constructor(readonly status: number | null) {
    super(`Cloudinary request failed${status === null ? "" : ` (HTTP ${status})`}.`);
    this.name = "CdnError";
  }
}

export type CdnClient = {
  /** Idempotent: the same public id always carries the same content. */
  upload(publicId: string, data: Buffer, contentType: string): Promise<void>;
  /** Deletes the original and every derived image and invalidates the CDN cache. A copy that is already gone is success. */
  destroy(publicId: string): Promise<void>;
};

const TIMEOUT_MS = 8_000;

export function cdnClient(config: CdnConfig, fetchImpl: typeof fetch = fetch): CdnClient {
  const endpoint = (action: "upload" | "destroy") => `https://api.cloudinary.com/v1_1/${config.cloudName}/image/${action}`;
  const post = async (action: "upload" | "destroy", params: Record<string, string>, file?: { data: Buffer; contentType: string }) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signed = { ...params, timestamp };
    const form = new FormData();
    for (const [k, v] of Object.entries(signed)) form.set(k, v);
    form.set("api_key", config.apiKey);
    form.set("signature", signCloudinary(signed, config.apiSecret));
    if (file) form.set("file", new Blob([new Uint8Array(file.data)], { type: file.contentType }), "photo");
    let response: Response;
    try {
      response = await fetchImpl(endpoint(action), { method: "POST", body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new CdnError(null);
    }
    if (!response.ok) throw new CdnError(response.status);
    return (await response.json().catch(() => null)) as { public_id?: string; result?: string } | null;
  };
  return {
    async upload(publicId, data, contentType) {
      const body = await post("upload", { public_id: publicId }, { data, contentType });
      if (body?.public_id !== publicId) throw new CdnError(200);
    },
    async destroy(publicId) {
      const body = await post("destroy", { public_id: publicId, invalidate: "true" });
      if (body?.result !== "ok" && body?.result !== "not found") throw new CdnError(200);
    },
  };
}

/** Widths offered in srcset: the same as the Office renditions (images.ts), kept here so a readiness probe does not load the image library. */
const WIDTHS = [320, 640, 1280] as const;
export type CdnImages = { src: string; srcSet: string };

/**
 * Responsive delivery straight from Cloudinary (no request passes through Next.js): `f_auto` picks WebP/AVIF per browser,
 * `q_auto` the quality, `c_limit` never enlarges beyond the stored size. `src` is the middle width (the fallback for a
 * browser that ignores srcset); `srcSet` lists every width.
 */
export function cdnImages(config: Pick<CdnConfig, "cloudName">, publicId: string): CdnImages {
  const url = (w: number) => `https://res.cloudinary.com/${config.cloudName}/image/upload/f_auto,q_auto,c_limit,w_${w}/${publicId}`;
  return { src: url(WIDTHS[1]), srcSet: WIDTHS.map((w) => `${url(w)} ${w}w`).join(", ") };
}
