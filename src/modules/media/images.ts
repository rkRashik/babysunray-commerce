import "server-only";
import { createHash, randomBytes } from "node:crypto";
import sharp, { type Metadata, type Sharp } from "sharp";
import { invalidInput } from "../domain-error";

// Validation and normalisation of uploaded product photos with sharp (libvips). The type is decided by the
// file's own bytes, never its name or the browser's claim; only JPEG, PNG and WebP are accepted (no SVG, HTML,
// GIF or anything executable). The whole image is decoded, so a damaged or truncated file is refused; it is
// then re-encoded in the same format with orientation applied and every piece of metadata dropped (EXIF,
// including any GPS position, XMP, comments, colour profile converted to sRGB). Only the re-encoded file is
// stored. Limits are technical bounds, not merchandising rules.

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const IMAGE_BOUNDS = { minSide: 200, maxSide: 8000, maxPixels: 40_000_000, storedMaxSide: 2400 } as const;
/** Widths the Office serves (srcset); anything else gets the stored size. */
export const RENDITION_WIDTHS = [320, 640, 1280] as const;

const FORMATS = {
  jpeg: { contentType: "image/jpeg", extension: "jpg" },
  png: { contentType: "image/png", extension: "png" },
  webp: { contentType: "image/webp", extension: "webp" },
} as const;
export type ImageFormat = keyof typeof FORMATS;
export type ImageContentType = (typeof FORMATS)[ImageFormat]["contentType"];

/** The format the bytes start with, or null for anything that is not JPEG, PNG or WebP. */
export function sniffImage(bytes: Uint8Array): ImageFormat | null {
  const at = (offset: number, signature: number[]) => signature.every((b, i) => bytes[offset + i] === b);
  if (at(0, [0xff, 0xd8, 0xff])) return "jpeg";
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "webp";
  return null;
}

export const formatOf = (contentType: string): ImageFormat | null =>
  (Object.keys(FORMATS) as ImageFormat[]).find((f) => FORMATS[f].contentType === contentType) ?? null;

export type StoredImage = { data: Buffer; format: ImageFormat; contentType: ImageContentType; extension: string; width: number; height: number; sha256: string };

/** Why a photo was refused: a stable code (safe in a redirect URL) and the message shown to the Owner. */
export const IMAGE_PROBLEMS = {
  empty: "is empty",
  too_large: "must be at most 10 MB",
  type: "must be a JPEG, PNG or WebP photo",
  damaged: "could not be read: the file is damaged, incomplete or not a real photo",
  mismatch: "content does not match its type",
  animated: "must not be animated",
  dimensions: `must be ${IMAGE_BOUNDS.minSide} to ${IMAGE_BOUNDS.maxSide} pixels on each side`,
} as const;
export type ImageProblem = keyof typeof IMAGE_PROBLEMS;
const refuse = (problem: ImageProblem) => invalidInput("image", IMAGE_PROBLEMS[problem]);
/** The code of a refusal thrown by normalizeImage, or null for any other error. */
export function imageProblemOf(error: unknown): ImageProblem | null {
  if (!(error instanceof Error)) return null;
  const found = (Object.keys(IMAGE_PROBLEMS) as ImageProblem[]).find((k) => error.message === `image ${IMAGE_PROBLEMS[k]}.`);
  return found ?? null;
}

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
export const uploadDigest = sha256;


/** Validates an uploaded photo and returns the metadata-free file to store. Throws INVALID_INPUT with a safe message. */
export async function normalizeImage(bytes: Buffer): Promise<StoredImage> {
  if (bytes.length === 0) throw refuse("empty");
  if (bytes.length > MAX_UPLOAD_BYTES) throw refuse("too_large");
  const format = sniffImage(bytes);
  if (!format) throw refuse("type");
  const input = () => sharp(bytes, { failOn: "warning", limitInputPixels: IMAGE_BOUNDS.maxPixels });
  let meta: Metadata;
  try {
    meta = await input().metadata();
  } catch {
    throw refuse("damaged");
  }
  if (meta.format !== format) throw refuse("mismatch");
  if ((meta.pages ?? 1) > 1) throw refuse("animated");
  const { width = 0, height = 0 } = meta;
  if (Math.min(width, height) < IMAGE_BOUNDS.minSide || Math.max(width, height) > IMAGE_BOUNDS.maxSide) {
    throw refuse("dimensions");
  }
  try {
    const { data, info } = await encode(input().rotate(), format, IMAGE_BOUNDS.storedMaxSide).toBuffer({ resolveWithObject: true });
    return { data, format, ...FORMATS[format], width: info.width, height: info.height, sha256: sha256(data) };
  } catch {
    throw refuse("damaged");
  }
}

function encode(pipeline: Sharp, format: ImageFormat, maxSide: number): Sharp {
  return output(pipeline.resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true }), format);
}

function output(pipeline: Sharp, format: ImageFormat): Sharp {
  if (format === "jpeg") return pipeline.jpeg({ quality: 85 });
  if (format === "png") return pipeline.png({ compressionLevel: 9 });
  return pipeline.webp({ quality: 85 });
}

/** A copy of a stored photo `width` pixels wide for display (same format), never larger than the stored one. */
export function renderWidth(data: Buffer, format: ImageFormat, width: number): Promise<Buffer> {
  return output(sharp(data, { failOn: "warning" }).resize({ width, withoutEnlargement: true }), format).toBuffer();
}

/** A new random storage key: 128 random bits as hex, with the format's extension. */
export const newStorageKey = (extension: string) => `${randomBytes(16).toString("hex")}.${extension}`;
